"""Resume the original interrupted request without changing its goal, site or design."""
import json,time,urllib.request
from pathlib import Path
def api(route,data=None):
 a=json.loads(Path('state/companion-api.json').read_text())
 return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+route,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
before=json.loads(Path('results/storehouse-interruption-before.json').read_text());s=api('/state')
assert s['requestProgress']['id']==before['requestProgress']['id'];assert s['canResume'] and s['connected'] and s['modelReady']
name=before['task']['goal']['name'];old=before['projects'][name]['construction'];new=s['projects'][name]['construction']
assert old['origin']==new['origin'] and old['design']==new['design']
Path('results/storehouse-resume-before.json').write_text(json.dumps(s,indent=2));print(api('/resume',{}),flush=True);started=time.time()
while time.time()-started<1800:
 s=api('/state');p=s.get('requestProgress') or {};t=s.get('task') or {}
 assert p.get('id')==before['requestProgress']['id'],'A new user request superseded this run'
 print(json.dumps({'elapsedAfterResume':round(time.time()-started),'phase':s['phase'],'position':s['position'],'activity':s['activity'],'progress':t.get('progress'),'last':s['messages'][-1]['text']}),flush=True)
 Path('results/storehouse-live-latest.json').write_text(json.dumps(s,indent=2))
 if s['phase'] in ['ready','blocked']:
  Path('results/storehouse-live-after.json').write_text(json.dumps(s,indent=2));print('FINISHED '+str(round(time.time()-started)),flush=True);break
 time.sleep(10)
