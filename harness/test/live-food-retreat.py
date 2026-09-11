"""Live model-planned lighting revision; no world setup, item grants or teleport."""
import json,time,urllib.request
from pathlib import Path
def api(route,data=None):
 a=json.loads(Path('state/companion-api.json').read_text())
 return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+route,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
s=api('/state');assert s['phase']=='ready' and s['connected'] and s['modelReady']
Path('results/food-retreat-live-before.json').write_text(json.dumps(s,indent=2))
request='Harvest at least 12 sweet berries directly from nearby ripe bushes using harvest, without breaking or uprooting them. The berry approach and base-entry checks are fixed. Start harvesting from here; do not detour through the old camp location. Keep the berries carried for emergencies. Preserve all buildings, stored supplies, tools and both diamonds. Then retreat into our saved lit base, close its door and wait inside. Keep Peaceful difficulty unchanged.'
Path('results/food-retreat-request.txt').write_text(request);print(api('/message',{'text':request}),flush=True);started=time.time()
while time.time()-started<2700:
 s=api('/state');p=s.get('requestProgress') or {};t=s.get('task') or {}
 if p.get('request')!=request:raise RuntimeError('User superseded request; no replay')
 print(json.dumps({'elapsed':round(time.time()-started),'phase':s['phase'],'position':s.get('position'),'ownerPosition':s.get('ownerPosition'),'activity':s.get('activity'),'progress':t.get('progress'),'last':s['messages'][-1]['text']}),flush=True)
 Path('results/food-retreat-live-latest.json').write_text(json.dumps(s,indent=2))
 if s['phase'] in ['ready','blocked']:
  Path('results/food-retreat-live-after.json').write_text(json.dumps(s,indent=2));print('FINISHED '+str(round(time.time()-started)),flush=True);break
 time.sleep(10)
