"""Run the reserved guesthouse with the normal live companion while the owner watches."""
import json,time,urllib.request
from pathlib import Path
def api(route,data=None):
 a=json.loads(Path('state/companion-api.json').read_text())
 return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+route,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
s=api('/state');assert s['phase']=='ready' and s['connected'] and s['modelReady'];assert json.loads(Path('results/visible-guesthouse-setup.json').read_text())['status']=='prepared'
Path('results/visible-guesthouse-before.json').write_text(json.dumps(s,indent=2))
request='Build the saved visible_guesthouse project now at its exact reserved origin (-594,67,-310), immediately west of our castle where I am watching. Use its saved blueprint with construct and empty design. The lab has prepared the ground pad and supplied ALL building materials. Continue in batches until finished. Open and test its door, barrel, crafting table and furnace; verify the bed assembly and access, and physically walk every checkpoint. Preserve the existing castle, starter base and stored/carried valuables. Do not gather materials or change sites. Finish at the guesthouse entrance so I can inspect it myself.'
Path('results/visible-guesthouse-request.txt').write_text(request)
print(api('/message',{'text':request}),flush=True);started=time.time();last=None
while time.time()-started<1800:
 s=api('/state');p=s.get('requestProgress') or {};t=s.get('task') or {}
 if p.get('request')!=request:raise RuntimeError('User superseded request; no replay')
 view={'elapsed':round(time.time()-started),'phase':s['phase'],'position':s.get('position'),'ownerPosition':s.get('ownerPosition'),'activity':s.get('activity'),'progress':t.get('progress'),'last':s['messages'][-1]['text']}
 if str(view)!=last:print(json.dumps(view),flush=True);last=str(view)
 Path('results/visible-guesthouse-latest.json').write_text(json.dumps(s,indent=2))
 if s['phase'] in ['ready','blocked']:
  Path('results/visible-guesthouse-after.json').write_text(json.dumps(s,indent=2));print('FINISHED '+str(round(time.time()-started)),flush=True);break
 time.sleep(10)
