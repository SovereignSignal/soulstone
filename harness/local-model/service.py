#!/usr/bin/env python3
"""Manage the optional, loopback-only Qwen baseline server. No profile activation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parent
MODEL = 'Qwen3.8-27B-UD-Q6_K.gguf'
SHA256 = 'c9c206812fbe4ac7b76a729e25928b63f2ae89d37f69da7a71c20aec763cd436'
ALIAS = 'minecraft-qwen3.8-27b-q6'
PORT = 1235
STATE = ROOT / 'state' / 'server.json'
BINARY = Path.home() / '.unsloth/llama.cpp/llama-server'


def birth(pid):
    return subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='], capture_output=True, text=True).stdout.strip()


def health():
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health', timeout=2) as response:
            return json.load(response)
    except Exception:
        return None


def verify():
    path = ROOT / 'weights' / MODEL
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while chunk := source.read(16 * 1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != SHA256:
        raise SystemExit('Model checksum mismatch. Complete or repeat the download before starting.')
    receipt = {'file': MODEL, 'bytes': path.stat().st_size, 'sha256': SHA256, 'mtimeNs': path.stat().st_mtime_ns}
    (ROOT / 'state').mkdir(exist_ok=True)
    (ROOT / 'state/weights.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


def start():
    import socket
    path = ROOT / 'weights' / MODEL
    receipt_path = ROOT / 'state/weights.json'
    if not receipt_path.exists():
        verify()
    receipt = json.loads(receipt_path.read_text())
    if receipt['sha256'] != SHA256 or receipt['bytes'] != path.stat().st_size or receipt['mtimeNs'] != path.stat().st_mtime_ns:
        verify()
    with socket.socket() as sock:
        try:
            sock.bind(('127.0.0.1', PORT))
        except OSError:
            raise SystemExit(f'Port {PORT} is already in use; no process was changed.')
    env = {k: v for k, v in os.environ.items() if not k.startswith(('LLAMA_ARG_', 'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'))}
    args = [str(BINARY), '--model', str(path), '--alias', ALIAS, '--host', '127.0.0.1', '--port', str(PORT),
            '--ctx-size', '16384', '--parallel', '1', '--n-gpu-layers', '999', '--jinja',
            '--cors-origins', 'localhost', '--no-cors-credentials', '--reasoning', 'off']
    with (ROOT / 'state/server.log').open('ab') as log:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=env, start_new_session=True)
    record = {'pid': process.pid, 'birth': birth(process.pid), 'model': ALIAS,
              'endpoint': f'http://127.0.0.1:{PORT}/v1/chat/completions', 'context': 16384, 'thinking': False}
    STATE.write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps({'started': record, 'health': health()}))


def status():
    record = json.loads(STATE.read_text()) if STATE.exists() else None
    owned = bool(record and record['birth'] and birth(record['pid']) == record['birth'])
    print(json.dumps({'ownedProcessRunning': owned, 'health': health(), 'server': record}))


def stop():
    if not STATE.exists():
        raise SystemExit('No managed server PID recorded.')
    record = json.loads(STATE.read_text())
    if not record['birth'] or birth(record['pid']) != record['birth']:
        raise SystemExit('Recorded process is no longer running; no process was signalled.')
    os.kill(record['pid'], signal.SIGTERM)
    print(json.dumps({'stopRequested': record['pid']}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['verify', 'start', 'status', 'stop'])
    globals()[parser.parse_args().action]()
