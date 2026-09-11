import json,time,urllib.request
from pathlib import Path
def api(route,data=None):
 a=json.loads(Path('state/companion-api.json').read_text())
 return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+route,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
s=api('/state');assert s['connected'];request_id=s['requestProgress']['id'];print(api('/resume',{}),flush=True)
for i in range(90):
 s=api('/state');assert s['requestProgress']['id']==request_id,'Request superseded'
 print(json.dumps({'phase':s['phase'],'activity':s.get('activity'),'inventory':s['inventory'],'last':s['messages'][-1]['text']}),flush=True)
 Path('results/survival-lighting-live-latest.json').write_text(json.dumps(s,indent=2))
 if s['phase'] in ['ready','blocked']:
  Path('results/survival-lighting-live-after.json').write_text(json.dumps(s,indent=2));break
 time.sleep(10)
