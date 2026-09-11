"""Exercise isolated world services, port edits and authenticated shutdown.

No model inference and no Minecraft world: both ports are closed localhost ports.
"""
import json, shutil, subprocess, tempfile, time, urllib.request, urllib.error, uuid
from pathlib import Path

harness=Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='soul-world-service-') as temp:
    root=Path(temp)
    def profile(name, port):
        return dict(id=str(uuid.uuid4()),name=name,host='127.0.0.1',port=port,owner='TestPlayer',username='SoulTest',auth='offline',version='auto',provider='codex',model='gpt-6-astra')
    first=profile('First',1); second=profile('Second',2)
    key=json.dumps(['world',first['id']],separators=(',',':'))
    first_dir=root/first['id']; (first_dir/'state').mkdir(parents=True)
    remembered=dict(profile=key,places={'home':{'x':1,'y':64,'z':2}},projects={},messages=[dict(id='old-message',role='assistant',text='World one history')],requestProgress=None,safety=None)
    (first_dir/'state/teammate.json').write_text(json.dumps(remembered))
    children=[]
    def start(setup):
        folder=root/setup['id'];folder.mkdir(exist_ok=True)
        path=folder/'setup.json';path.write_text(json.dumps(setup))
        log=(folder/'log').open('w')
        p=subprocess.Popen([shutil.which('node'),str(harness/'src/companion/server.js')],cwd=folder,
            env=dict(HOME=temp,PATH='/usr/bin:/bin',TMPDIR=temp,MC_SETUP_FILE=str(path),MC_RECORD_EPISODES='0'),stdout=log,stderr=log)
        children.append(p);deadline=time.monotonic()+10
        endpoint=folder/'state/companion-api.json'
        while True:
            assert p.poll() is None, 'World service failed: '+(folder/'log').read_text()
            if endpoint.exists():
                info=json.loads(endpoint.read_text())
                if info['pid']==p.pid: break
            assert time.monotonic()<deadline, 'World service startup timed out'
            time.sleep(.1)
        def request(path='/state',auth=True):
            req=urllib.request.Request(info['url']+path,headers={'Authorization':'Bearer '+info['token']} if auth else {},method='POST' if path=='/shutdown' else 'GET',data=b'{}' if path=='/shutdown' else None)
            try:
                with urllib.request.urlopen(req,timeout=4) as r:return r.status,json.load(r)
            except urllib.error.HTTPError as e:return e.code,json.load(e)
        return p,request
    def stop(p,request):
        assert request('/shutdown',False)[0]==403
        assert p.poll() is None
        assert request('/shutdown')[0]==202
        p.wait(timeout=7)
        assert p.returncode==0
    try:
        p,a=start(first);s=a()[1];assert s['worldId']==first['id'] and s['places']==remembered['places'];stop(p,a)
        p,b=start(second);s=b()[1];assert s['worldId']==second['id'] and s['places']=={} and s['messages']==[];stop(p,b)
        first['port']=2;first['version']='26.1'
        p,a=start(first);s=a()[1];assert s['worldId']==first['id'] and s['places']==remembered['places'] and s['messages']==remembered['messages'];stop(p,a)
        print(json.dumps(dict(status='passed',worldsIsolated=True,contextSurvivesPortAndVersionEdits=True,authenticatedShutdown=True,unauthorizedShutdownRejected=True,previousServicesExited=True),indent=2))
    finally:
        for p in children:
            if p.poll() is None:p.terminate();p.wait(timeout=7)
