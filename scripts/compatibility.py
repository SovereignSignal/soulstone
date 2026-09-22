#!/usr/bin/env python3
"""Check, stage and adopt an official ViaProxy release without installing the app."""
from pathlib import Path
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'companion/scripts'))
from bridge_support import verify, digest, adapter_name, probe

API = 'https://api.github.com/repos/ViaVersion/ViaProxy'
ASSETS = ROOT / 'harness/bridge'


def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'SoulStone-compatibility-upgrade', 'Accept': 'application/vnd.github+json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        return response.read()


def release(tag=None):
    if tag and not re.fullmatch(r'v\d+(?:\.\d+)+', tag):
        raise ValueError('Use an official stable release tag such as v3.4.12')
    value = json.loads(fetch(API + ('/releases/tags/' + tag if tag else '/releases/latest')))
    if value.get('draft') or value.get('prerelease') or not re.fullmatch(r'v\d+(?:\.\d+)+', value['tag_name']):
        raise ValueError('Only official stable releases are accepted')
    return value


def select_asset(value):
    name = f'ViaProxy-{value["tag_name"][1:]}.jar'
    matches = [a for a in value['assets'] if a['name'] == name]
    if len(matches) != 1:
        raise ValueError(f'Release has no unique {name}')
    asset = matches[0]
    expected_url = f'https://github.com/ViaVersion/ViaProxy/releases/download/{value["tag_name"]}/{name}'
    if asset['browser_download_url'] != expected_url or not re.fullmatch(r'sha256:[a-f0-9]{64}', asset.get('digest') or ''):
        raise ValueError('Release asset lacks an official download URL and SHA-256 digest')
    return asset


def stage(args):
    current = verify(ASSETS)
    upstream = release(args.tag)
    asset = select_asset(upstream)
    output = args.output.resolve()
    if output.exists():
        raise ValueError('Candidate output already exists; choose a new directory')
    output.mkdir(parents=True)
    receipt = {'status': 'staging', 'release': upstream['html_url'], 'requested': {'version': args.target, 'protocol': args.protocol},
               'baseManifestSha256': digest(ASSETS / 'compatibility.json'), 'gameplay': 'not tested'}
    try:
        jar = output / asset['name']
        if upstream['tag_name'] == current['release'] and asset['digest'][7:] == current['sha256']:
            shutil.copy2(ASSETS / current['jar'], jar)
        else:
            jar.write_bytes(fetch(asset['browser_download_url']))
        if digest(jar) != asset['digest'][7:]:
            raise ValueError('Downloaded ViaProxy checksum differs from GitHub release digest')
        # Preserve the exact already-pinned source archive when checking the same release.
        source_name = jar.stem + '-source.zip'
        source = output / source_name
        if upstream['tag_name'] == current['release'] and digest(jar) == current['sha256']:
            shutil.copy2(ASSETS / current['source'], source)
        else:
            source.write_bytes(fetch(f'https://api.github.com/repos/ViaVersion/ViaProxy/zipball/{upstream["tag_name"]}'))
        license_bytes = fetch(f'https://raw.githubusercontent.com/ViaVersion/ViaProxy/{upstream["tag_name"]}/LICENSE')
        (output / 'ViaProxy-LICENSE').write_bytes(license_bytes)
        routes = list(current['routes'])
        candidate = {'version': args.target, 'protocol': args.protocol}
        if candidate not in routes:
            routes.append(candidate)
        routes.sort(key=lambda route: route['protocol'])
        pin = {**current, 'release': upstream['tag_name'], 'jar': jar.name, 'sha256': digest(jar),
               'source': source_name, 'sourceSha256': digest(source), 'routes': routes}
        (output / 'compatibility.json').write_text(json.dumps(pin, indent=2) + '\n')
        verify(output)
        subprocess.run([sys.executable, str(ROOT / 'companion/scripts/build-bridge.py'), '--assets', str(output)], check=True)
        receipt['routes'] = probe(output, pin)
        receipt['licenseSha256'] = digest(output / 'ViaProxy-LICENSE')
        receipt['manifestSha256'] = digest(output / 'compatibility.json')
        receipt['status'] = 'translation-verified'
    except Exception as error:
        receipt['status'] = 'blocked'
        receipt['error'] = str(error)
    (output / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt, indent=2))
    return 0 if receipt['status'] == 'translation-verified' else 2


def apply(candidate):
    candidate = candidate.resolve()
    receipt = json.loads((candidate / 'receipt.json').read_text())
    value = verify(candidate)
    if receipt.get('status') != 'translation-verified':
        raise ValueError('Candidate has not passed translation verification')
    if receipt['manifestSha256'] != digest(candidate / 'compatibility.json') or receipt['licenseSha256'] != digest(candidate / 'ViaProxy-LICENSE'):
        raise ValueError('Candidate changed after verification; stage it again')
    if receipt['baseManifestSha256'] != digest(ASSETS / 'compatibility.json'):
        raise ValueError('Repository compatibility pin changed; stage again against the current pin')
    current = verify(ASSETS)
    if any(route not in value['routes'] for route in current['routes']):
        raise ValueError('Upgrade would drop an existing supported route')
    # Recompile from this checkout and recheck every path, including old versions.
    subprocess.run([sys.executable, str(ROOT / 'companion/scripts/build-bridge.py'), '--assets', str(candidate)], check=True)
    probe(candidate, value)
    filenames = [value['jar'], value['source'], adapter_name(value)]
    for name in filenames:
        destination = ASSETS / name
        if destination.exists() and digest(destination) != digest(candidate / name):
            # Generated adapters may change when this checkout changes. Applying a
            # new release never overwrites the old release's adapter or binary.
            if name != adapter_name(value):
                raise ValueError(f'Refusing to overwrite a different existing artifact: {name}')
    # Add versioned files first and change the active pin last. Previous artifacts
    # remain available for rollback. An interrupted copy cannot activate a partial pin.
    for name in filenames + ['ViaProxy-LICENSE', 'compatibility.json']:
        with tempfile.NamedTemporaryFile(dir=ASSETS, prefix='.compat-', delete=False) as pending:
            pending.write((candidate / name).read_bytes())
            path = Path(pending.name)
        path.replace(ASSETS / name)
    print('Applied compatibility pin to source. Rebuild and test the app before installing. No game connection was opened.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('check', help='Read current pin and latest upstream release; no downloads or writes')
    staging = commands.add_parser('stage', help='Download, verify, compile and probe a candidate; leave active source/app unchanged')
    staging.add_argument('--tag', help='Official release tag; defaults to latest')
    staging.add_argument('--target', required=True, help='Minecraft version, e.g. 26.3')
    staging.add_argument('--protocol', type=int, required=True, help='Protocol reported by the Minecraft server')
    staging.add_argument('--output', type=Path, required=True, help='New directory for candidate and receipt')
    adoption = commands.add_parser('apply', help='Adopt a verified staged bundle into source; does not install or launch')
    adoption.add_argument('candidate', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'check':
            current, upstream = verify(ASSETS), release()
            print(json.dumps({'currentRelease': current['release'], 'currentRoutes': current['routes'], 'latestRelease': upstream['tag_name'],
                              'releaseUrl': upstream['html_url'], 'newReleaseAvailable': current['release'] != upstream['tag_name'],
                              'note': 'Release availability does not prove version support. Stage the target version to verify translation.'}, indent=2))
        elif args.command == 'stage':
            if not re.fullmatch(r'\d+\.\d+(?:\.\d+)?', args.target) or args.protocol <= 0:
                raise ValueError('Use a released Minecraft version and positive protocol number')
            return stage(args)
        else:
            apply(args.candidate)
    except Exception as error:
        print(f'Compatibility: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
