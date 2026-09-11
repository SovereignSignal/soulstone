import json,time,urllib.request
from pathlib import Path
def api(route,data=None):
 a=json.loads(Path('state/companion-api.json').read_text())
 return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+route,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
s=api('/state');assert s['connected'];print(api('/message',{'text':'The executor has been reloaded with a fix for the Java 1.21.4 sneak-state protocol. Retry the saved compact_storehouse lighting revision now using construct with its exact saved design and origin, without adding or changing the blueprint. Use the carried torches, then verify all cells, the door, barrels, crafting table and six checkpoints. Preserve all other projects, tools and both diamonds. Finish at the entrance and report observed hunger and nearby threats. Keep Peaceful unchanged.'}),flush=True);request_id=api('/state')['requestProgress']['id']
for i in range(90):
 s=api('/state');assert s['requestProgress']['id']==request_id,'Request superseded'
 print(json.dumps({'phase':s['phase'],'activity':s.get('activity'),'inventory':s['inventory'],'last':s['messages'][-1]['text']}),flush=True)
 Path('results/survival-lighting-live-latest.json').write_text(json.dumps(s,indent=2))
 if s['phase'] in ['ready','blocked']:
  Path('results/survival-lighting-live-after.json').write_text(json.dumps(s,indent=2));break
 time.sleep(10)
