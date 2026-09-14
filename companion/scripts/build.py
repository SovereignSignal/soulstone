#!/usr/bin/env python3
"""Build a development Mac app without Xcode project generation or paid services."""
from pathlib import Path
import argparse, json, plistlib, shutil, subprocess, sys
parser = argparse.ArgumentParser()
parser.add_argument("--portable", action="store_true")
args = parser.parse_args()
minimum_macos = "14.0"
root = Path(__file__).resolve().parents[2]
# Stamp the harness revision so lessons can be tied to the executor that produced them.
import datetime
try: commit = subprocess.check_output(['git','rev-parse','--short','HEAD'],cwd=root,text=True,stderr=subprocess.DEVNULL).strip()
except Exception: commit = 'unknown'
build = root / 'companion' / 'build'
subprocess.run([sys.executable,str(root/'companion/scripts/build-bridge.py')],check=True)
app = (build / 'portable' if args.portable else build) / 'SoulStone.app'
contents = app / 'Contents'
(contents/'MacOS').mkdir(parents=True,exist_ok=True)
(contents/'Resources').mkdir(exist_ok=True)
plist = {'CFBundleIdentifier':'com.sovereignsignal.minecraft-teammate','CFBundleName':'SoulStone','CFBundleDisplayName':'SoulStone','CFBundleIconFile':'AppIcon','CFBundleExecutable':'MinecraftTeammate','CFBundlePackageType':'APPL','CFBundleShortVersionString':'0.1.0','CFBundleVersion':'92','LSMinimumSystemVersion':minimum_macos,'NSMicrophoneUsageDescription':'Speak to SoulStone using push-to-talk.','NSSpeechRecognitionUsageDescription':'Transcribe your Minecraft requests on this Mac. Audio is not sent to a paid API.','NSAppTransportSecurity':{'NSAllowsLocalNetworking':True},'NSHighResolutionCapable':True}
resources = root/'companion'/'Resources'
for asset in resources.glob('*.png'):
    shutil.copy2(asset, contents/'Resources'/asset.name)
iconset = root/'companion'/'build'/'AppIcon.iconset'
iconset.mkdir(exist_ok=True)
for size in [16, 32, 128, 256, 512]:
    for scale in [1, 2]:
        suffix = '@2x' if scale == 2 else ''
        subprocess.run(['sips','-z',str(size*scale),str(size*scale),str(resources/'SoulLantern.png'),'--out',str(iconset/f'icon_{size}x{size}{suffix}.png')],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['iconutil','-c','icns',str(iconset),'-o',str(contents/'Resources'/'AppIcon.icns')],check=True)
(contents/'Info.plist').write_bytes(plistlib.dumps(plist))
(root/'harness'/'src'/'revision.json').write_text(json.dumps({'revision':f"bundle-{plist['CFBundleVersion']}-{commit}",'bundle':plist['CFBundleVersion'],'commit':commit,'builtAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}))
if args.portable:
    # Explicit source allowlist: never package .env, state, results or local profiles.
    runtime = contents/'Resources'/'runtime'
    runtime.mkdir(exist_ok=True)
    node = Path(shutil.which('node')).resolve()
    libraries = subprocess.check_output(['otool','-L',str(node)],text=True).splitlines()[1:]
    if any(not line.strip().startswith(('/usr/lib/','/System/Library/')) for line in libraries):
        raise RuntimeError('Node depends on external libraries and cannot be bundled as-is')
    shutil.copy2(node,runtime/'node')
    license_path = node.parent.parent/'LICENSE'
    if not license_path.exists():
        raise RuntimeError('Node distribution LICENSE is required for packaging')
    shutil.copy2(license_path,runtime/'NODE-LICENSE')
    source = root/'harness'
    target = runtime/'harness'
    for folder in ['src','node_modules','bridge']:
        destination = target/folder
        if destination.exists(): shutil.rmtree(destination)
        # Reject symlinks that would pull local files into the release.
        for item in (source/folder).rglob('*'):
            if item.is_symlink() and not item.resolve().is_relative_to((source/folder).resolve()):
                raise RuntimeError(f'External symlink in {folder}')
        shutil.copytree(source/folder,destination,symlinks=True)
    for filename in ['package.json','package-lock.json']:
        shutil.copy2(source/filename,target/filename)
    (contents/'Resources'/'development.json').unlink(missing_ok=True)
    subprocess.run(['codesign','--force','--sign','-',str(runtime/'node')],check=True)
else:
    (contents/'Resources'/'development.json').write_text(json.dumps({'workspace':str(root),'node':shutil.which('node')}))
subprocess.run(['swiftc','-target',f'arm64-apple-macosx{minimum_macos}','-parse-as-library','-swift-version','5','-module-cache-path',str(root/'companion'/'build'/'ModuleCache'),*[str(path) for path in sorted((root/'companion'/'Sources').glob('*.swift'))],'-o',str(contents/'MacOS'/'MinecraftTeammate'),'-framework','SwiftUI','-framework','Speech','-framework','AVFoundation','-framework','Carbon','-framework','Security'],check=True)
subprocess.run(['codesign','--force','--sign','-','--identifier','com.sovereignsignal.minecraft-teammate',str(app)],check=True)
print(app)
