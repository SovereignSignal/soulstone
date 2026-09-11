"""Live model-planned lighting revision; no world setup, item grants or teleport."""
import json,time,urllib.request
from pathlib import Path
def api(route,data=None):
 a=json.loads(Path('state/companion-api.json').read_text())
 return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+route,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
s=api('/state');assert s['phase']=='ready' and s['connected'] and s['modelReady']
Path('results/survival-lighting-live-before.json').write_text(json.dumps(s,indent=2))
request='Improve lighting inside compact_storehouse using at most two of your carried torches. Inspect its saved design and choose floor-supported placements inside, including on top of furnishings if appropriate. Revise only this existing project, preserve every existing structure and furnishing, both diamonds and all tools. Verify the door, both barrels, crafting table and all walking checkpoints again, and finish at its entrance. Report your hunger, carried food and nearby threats too. Keep the lab difficulty unchanged. Distinguish confirmed torch placement from measured lighting and hostile-survival readiness.'
Path('results/survival-lighting-request.txt').write_text(request);print(api('/message',{'text':request}),flush=True);started=time.time()
while time.time()-started<2700:
 s=api('/state');p=s.get('requestProgress') or {};t=s.get('task') or {}
 if p.get('request')!=request:raise RuntimeError('User superseded request; no replay')
 print(json.dumps({'elapsed':round(time.time()-started),'phase':s['phase'],'position':s.get('position'),'ownerPosition':s.get('ownerPosition'),'activity':s.get('activity'),'progress':t.get('progress'),'last':s['messages'][-1]['text']}),flush=True)
 Path('results/survival-lighting-live-latest.json').write_text(json.dumps(s,indent=2))
 if s['phase'] in ['ready','blocked']:
  Path('results/survival-lighting-live-after.json').write_text(json.dumps(s,indent=2));print('FINISHED '+str(round(time.time()-started)),flush=True);break
 time.sleep(10)
