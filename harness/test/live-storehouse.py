"""Live natural build; no world setup, item grants, bot teleport or blueprint injection."""
import json,time,urllib.request
from pathlib import Path
def api(route,data=None):
 a=json.loads(Path('state/companion-api.json').read_text())
 return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+route,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
s=api('/state');assert s['phase']=='ready' and s['connected'] and s['modelReady']
Path('results/storehouse-live-before.json').write_text(json.dumps(s,indent=2))
request='Build a small usable storehouse near me, separate from our castle, guesthouse and starter base. Choose your own compact design and natural site from the terrain survey. Include an enclosed roofed interior, a working wooden door, two barrels and a crafting table with clear access. Reserve the site and calculate materials before placing. Use materials already carried or gathered and crafted naturally; there are no administrator-supplied items or prepared pads. Preserve all existing buildings, stored items, tools and diamonds. Verify the door, both barrels, crafting table and every walk checkpoint, then finish by the new entrance where I can inspect it.'
Path('results/storehouse-request.txt').write_text(request);print(api('/message',{'text':request}),flush=True);started=time.time()
while time.time()-started<2700:
 s=api('/state');p=s.get('requestProgress') or {};t=s.get('task') or {}
 if p.get('request')!=request:raise RuntimeError('User superseded request; no replay')
 print(json.dumps({'elapsed':round(time.time()-started),'phase':s['phase'],'position':s.get('position'),'ownerPosition':s.get('ownerPosition'),'activity':s.get('activity'),'progress':t.get('progress'),'last':s['messages'][-1]['text']}),flush=True)
 Path('results/storehouse-live-latest.json').write_text(json.dumps(s,indent=2))
 if s['phase'] in ['ready','blocked']:
  Path('results/storehouse-live-after.json').write_text(json.dumps(s,indent=2));print('FINISHED '+str(round(time.time()-started)),flush=True);break
 time.sleep(10)
