import json,time,urllib.request
from pathlib import Path

def api(route,data=None):
    a=json.loads(Path('state/companion-api.json').read_text())
    return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+route,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
s=api('/state');assert s['phase']=='ready' and s['connected'] and s['modelReady'];assert s['inventory'].get('stone_bricks',0)>=253
Path('results/live-castle-before.json').write_text(json.dumps(s,indent=2))
request='Build the saved castle project now using its exact blueprint and prepared site. The lab has supplied all building blocks. Continue construction in batches until the whole castle is complete, then physically verify the entrance, hall, stairs, roof terrace, all four turret tops and return to the entrance. Preserve our original base, chest, tools and diamond. Do not gather or give materials for this supplied construction test.'
Path('results/live-castle-request.txt').write_text(request)
print(api('/message',{'text':request}),flush=True)
started=time.time();last=''
while time.time()-started<2400:
    time.sleep(10);s=api('/state');p=s.get('requestProgress') or {};t=s.get('task') or {}
    v={'phase':s['phase'],'rounds':p.get('rounds'),'kind':t.get('kind'),'status':t.get('status'),'progress':t.get('progress'),'activity':s.get('activity'),'last':s['messages'][-1]['text']}
    if json.dumps(v)!=last:print(json.dumps(v),flush=True);last=json.dumps(v)
    Path('results/live-castle-latest.json').write_text(json.dumps(s,indent=2))
    if s['phase'] in ['ready','blocked'] and p.get('request')==request:
        Path('results/live-castle-after.json').write_text(json.dumps(s,indent=2));print('FINISHED '+str(round(time.time()-started,2)),flush=True);break
