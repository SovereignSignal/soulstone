#!/usr/bin/env python3
"""Build the small ViaProxy adapter from source using Minecraft's installed JDK."""
from pathlib import Path
import hashlib, subprocess, zipfile
root=Path(__file__).resolve().parents[2]
assets=root/'harness/bridge'
jar=assets/'ViaProxy-3.4.12.jar'
assert hashlib.sha256(jar.read_bytes()).hexdigest()=='32ce9ad871aeb03286823c29da262ebd75992864e7857db283f103525c7fc0cb', 'Unexpected ViaProxy binary'
base=Path.home()/'Library/Application Support/minecraft/runtime'
javac=next((base/name/'mac-os-arm64'/name/'jre.bundle/Contents/Home/bin/javac' for name in ['java-runtime-epsilon','java-runtime-delta'] if (base/name/'mac-os-arm64'/name/'jre.bundle/Contents/Home/bin/javac').exists()),None)
if not javac: raise SystemExit('Launch Minecraft once to install its Java runtime, then rebuild.')
classes=root/'companion/build/bridge-classes';classes.mkdir(parents=True,exist_ok=True)
subprocess.run([str(javac),'-proc:none','--release','17','-cp',str(jar),'-d',str(classes),*[str(p) for p in sorted((root/'companion/bridge').glob('*.java'))]],check=True)
with zipfile.ZipFile(assets/'SoulStoneBridge.pending.jar','w',zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('META-INF/MANIFEST.MF','Manifest-Version: 1.0\nMain-Class: soulstone.SoulStoneLauncher\nClass-Path: ViaProxy-3.4.12.jar\nLauncher-Agent-Class: net.raphimc.viaproxy.ViaProxy\n\n')
    for p in classes.rglob('*.class'): archive.write(p,str(p.relative_to(classes)))
    archive.write(root/'companion/bridge/viaproxy.yml','viaproxy.yml')
(assets/'SoulStoneBridge.pending.jar').replace(assets/'SoulStoneBridge.jar')
source=assets/'source';source.mkdir(exist_ok=True)
for p in (root/'companion/bridge').glob('*'):
    if p.is_file(): (source/p.name).write_bytes(p.read_bytes())
print('Built SoulStoneBridge.jar')
