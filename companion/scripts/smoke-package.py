#!/usr/bin/env python3
"""Check the portable bundle from an empty profile, without a game or model call."""
from pathlib import Path
import json, os, shutil, subprocess, tempfile, time, urllib.request
bundle = Path(__file__).resolve().parents[1]/'build'/'portable'/'SoulStone.app'
resources = bundle/'Contents'/'Resources'
assert not (resources/'development.json').exists(), 'Developer launch configuration leaked'
runtime = resources/'runtime'
harness = runtime/'harness'
assert sorted(p.name for p in harness.iterdir()) == ['bridge','node_modules','package-lock.json','package.json','src']
assert not any(p.name in ['.env','companion-api.json','teammate.json','models.json'] for p in harness.rglob('*'))
subprocess.run(['codesign','--verify','--deep','--strict',str(bundle)],check=True)
with tempfile.TemporaryDirectory(prefix='soulstone-clean-') as tmp:
    root=Path(tmp)
    relocated=root/'SoulStone.app'
    shutil.copytree(bundle,relocated,symlinks=True)
    runtime=relocated/'Contents'/'Resources'/'runtime'
    harness=runtime/'harness'
    profile=dict(host='127.0.0.1',port=1,owner='TestPlayer',username='TestSoul',auth='offline',version='1.21.4',provider='codex',model='gpt-6-astra')
    (root/'setup.json').write_text(json.dumps(profile))
    env={'HOME':tmp,'PATH':'/usr/bin:/bin','TMPDIR':tmp,'MC_SETUP_FILE':str(root/'setup.json')}
    with (root/'log').open('w') as log:
        child=subprocess.Popen([str(runtime/'node'),str(harness/'src/companion/server.js')],cwd=tmp,env=env,stdout=log,stderr=log)
        try:
            endpoint=root/'state'/'companion-api.json'
            for _ in range(100):
                if endpoint.exists(): break
                if child.poll() is not None: raise RuntimeError((root/'log').read_text())
                time.sleep(.1)
            info=json.loads(endpoint.read_text())
            def get(path,token):
                return json.load(urllib.request.urlopen(urllib.request.Request(info['url']+path,headers={'Authorization':'Bearer '+token}),timeout=4))
            state=get('/state',info['token'])
            assert state['owner']=='TestPlayer'
            assert state['inventory']=={} and state['messages']==[]
            assert state['providerKind']=='codex' and state['model']=='gpt-6-astra'
            assert state['connected'] is False
            assert get('/models',info['token'])['active']=='subscription-default'
            try: get('/state','invalid')
            except urllib.error.HTTPError as error: assert error.code==403
            else: raise AssertionError('Unauthenticated state was exposed')
            assert endpoint.stat().st_mode & 0o777 == 0o600
            print('PASS: relocated runtime, empty private profile, model selection, authenticated API, restrictive file permissions. No game session or model call.')
        finally:
            child.terminate()
            try: child.wait(timeout=8)
            except subprocess.TimeoutExpired: child.kill(); child.wait()
