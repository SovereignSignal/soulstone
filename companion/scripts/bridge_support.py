"""Shared build and release checks for the pinned Minecraft translation bundle."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import tempfile


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def manifest(assets):
    value = json.loads((Path(assets) / 'compatibility.json').read_text())
    if value.get('schema') != 1 or not re.fullmatch(r'v\d+(?:\.\d+)+', value['release']):
        raise ValueError('Invalid compatibility release')
    version = value['release'][1:]
    if value['jar'] != f'ViaProxy-{version}.jar' or value['source'] != f'ViaProxy-{version}-source.zip':
        raise ValueError('Compatibility filenames must match the release')
    for key in ['sha256', 'sourceSha256']:
        if not re.fullmatch(r'[a-f0-9]{64}', value[key]):
            raise ValueError('Invalid compatibility checksum')
    routes = value['routes']
    if not routes or len({r['version'] for r in routes}) != len(routes) or len({r['protocol'] for r in routes}) != len(routes):
        raise ValueError('Compatibility routes must be nonempty and unique')
    for route in routes + [{'version': value['clientVersion'], 'protocol': value['clientProtocol']}]:
        if not re.fullmatch(r'\d+\.\d+(?:\.\d+)?', route['version']) or type(route['protocol']) is not int or route['protocol'] <= 0:
            raise ValueError('Invalid Minecraft version or protocol')
    return value


def verify(assets):
    value = manifest(assets)
    for filename, checksum in [(value['jar'], value['sha256']), (value['source'], value['sourceSha256'])]:
        if digest(Path(assets) / filename) != checksum:
            raise ValueError(f'Integrity check failed: {filename}')
    return value


def java_tool(name):
    base = Path.home() / 'Library/Application Support/minecraft/runtime'
    for runtime in ['java-runtime-epsilon', 'java-runtime-delta']:
        path = base / runtime / 'mac-os-arm64' / runtime / 'jre.bundle/Contents/Home/bin' / name
        if path.is_file():
            return path
    raise RuntimeError('Launch Minecraft once to install its Java runtime, then retry.')


def adapter_name(value):
    return value['jar'].replace('ViaProxy-', 'SoulStoneBridge-')


def probe(assets, value):
    """Start only loopback listeners; no player, login, game connection or inference."""
    import os
    import selectors
    import time
    assets = Path(assets).resolve()
    results = []
    for route in value['routes']:
        with tempfile.TemporaryDirectory(prefix='soulstone-route-probe-') as folder:
            run = Path(folder)
            (run / 'plugins').mkdir()
            (run / 'plugins/SoulStoneBridge.jar').write_bytes((assets / adapter_name(value)).read_bytes())
            command = [str(java_tool('java')), '-Xmx512m', '-Djava.awt.headless=true', '-jar', str(assets / adapter_name(value)),
                       'cli', '--bind-address', '127.0.0.1:0', '--target-address', '127.0.0.1:1',
                       '--target-version', route['version'], '--proxy-online-mode', 'true', '--auth-method', 'NONE',
                       '--log-ips', 'false', '--simple-voice-chat-support', 'false', '--rewrite-transfer-packets', 'false']
            child = subprocess.Popen(command, cwd=run, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
            ready = None
            output = bytearray()
            try:
                identity = {'uuid': '00000000-0000-4000-8000-000000000001', 'clientProtocol': value['clientProtocol'], 'serverProtocol': route['protocol']}
                child.stdin.write((json.dumps(identity) + '\n').encode())
                child.stdin.flush()
                with selectors.DefaultSelector() as selector:
                    selector.register(child.stdout, selectors.EVENT_READ)
                    deadline = time.monotonic() + 35
                    buffer = b''
                    while time.monotonic() < deadline and ready is None:
                        if not selector.select(timeout=0.2):
                            if child.poll() is not None:
                                break
                            continue
                        chunk = os.read(child.stdout.fileno(), 65536)
                        if not chunk:
                            break
                        output.extend(chunk)
                        buffer += chunk
                        while b'\n' in buffer:
                            line, buffer = buffer.split(b'\n', 1)
                            if b'SOULSTONE_BRIDGE ' not in line:
                                continue
                            event = json.loads(line.split(b'SOULSTONE_BRIDGE ', 1)[1])
                            if event.get('type') == 'unsupported_route':
                                raise RuntimeError(f'ViaProxy has no verified {value["clientVersion"]} -> {route["version"]} translation path (server protocol {route["protocol"]}).')
                            if event.get('type') == 'ready':
                                if event.get('serverProtocol') != route['protocol'] or event.get('clientProtocol') != value['clientProtocol']:
                                    raise ValueError('Helper reported the wrong protocol route')
                                ready = event
            finally:
                child.stdin.close()
                try:
                    child.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
                child.stdout.close()
            if ready is None:
                detail = output.decode(errors='replace')[-5000:]
                raise RuntimeError(f'No verified {value["clientVersion"]} -> {route["version"]} translation route.\n{detail}')
            results.append({'version': route['version'], 'protocol': route['protocol'], 'translation': 'passed', 'gameplay': 'not tested'})
    return results
