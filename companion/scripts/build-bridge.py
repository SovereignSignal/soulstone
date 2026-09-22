#!/usr/bin/env python3
"""Build the adapter against the single, integrity-checked compatibility manifest."""
from pathlib import Path
import argparse
import subprocess
import tempfile
import zipfile
from bridge_support import verify, java_tool, adapter_name, probe

root = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--assets', type=Path, default=root / 'harness/bridge')
parser.add_argument('--probe', action='store_true', help='Verify translation paths without joining a game')
args = parser.parse_args()
assets = args.assets.resolve()
value = verify(assets)
with tempfile.TemporaryDirectory(prefix='soulstone-bridge-build-') as folder:
    classes = Path(folder)
    subprocess.run([str(java_tool('javac')), '-proc:none', '--release', '17', '-cp', str(assets / value['jar']), '-d', str(classes),
                    *[str(p) for p in sorted((root / 'companion/bridge').glob('*.java'))]], check=True)
    pending = assets / (adapter_name(value) + '.pending')
    with zipfile.ZipFile(pending, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('META-INF/MANIFEST.MF', f'Manifest-Version: 1.0\nMain-Class: soulstone.SoulStoneLauncher\nClass-Path: {value["jar"]}\nLauncher-Agent-Class: net.raphimc.viaproxy.ViaProxy\n\n')
        for p in sorted(classes.rglob('*.class')):
            archive.write(p, str(p.relative_to(classes)))
        archive.write(root / 'companion/bridge/viaproxy.yml', 'viaproxy.yml')
    pending.replace(assets / adapter_name(value))
source = assets / 'source'
source.mkdir(exist_ok=True)
for p in (root / 'companion/bridge').glob('*'):
    if p.is_file():
        (source / p.name).write_bytes(p.read_bytes())
print(f'Built {adapter_name(value)}')
if args.probe:
    import json
    print(json.dumps(probe(assets, value), indent=2))
