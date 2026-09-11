"""Normal model-directed food replenishment after the real eating drill."""
import json,time,urllib.request
from pathlib import Path
def api(route,data=None):
 a=json.loads(Path('state/companion-api.json').read_text())
 return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+route,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
s=api('/state');assert s['connected'] and s['phase']=='ready' and s['survival']['difficulty']=='peaceful'
assert 0<s['inventory'].get('sweet_berries',0)<32
report={'status':'running','before':s};connection=s['connectionId']
request='Replenish your carried food reserve to at least 32 sweet berries by harvesting ripe wild bushes without breaking them. Leave the base through its door, gather the food, then retreat inside the lit base and close the door. Preserve the seven spruce logs, both diamonds, all tools, buildings and base storage. Keep Peaceful difficulty unchanged.'
report['request']=request;api('/message',{'text':request});last_print=0
try:
 for _ in range(720):
  s=api('/state');rp=s.get('requestProgress') or {}
  assert rp.get('request')==request,'User superseded request'
  assert s['connected'] and s['connectionId']==connection,'Connection changed'
  if time.monotonic()-last_print>15:
   print(json.dumps({'phase':s['phase'],'berries':s['inventory'].get('sweet_berries'),'activity':s.get('activity'),'health':s['health']}),flush=True);last_print=time.monotonic()
  if s['phase'] in ['ready','blocked']:
   report['after']=s
   assert s['phase']=='ready',s['messages'][-1]['text']
   assert s['inventory']['sweet_berries']>=32 and s['health']==20
   for item in ['diamond','spruce_log']:assert s['inventory'][item]==report['before']['inventory'][item]
   feedback=rp.get('feedback',[])
   assert any(f.get('action')=='harvest' and f.get('status')=='completed' and f.get('result',{}).get('harvested') for f in feedback)
   assert any(f.get('action')=='retreat' and f.get('result',{}).get('receipt')=='sheltered_door_closed' for f in feedback)
   assert any(c.get('kind')=='sheltered' and c.get('passed') for c in rp['verification']['checks'])
   report['status']='passed';break
  time.sleep(1)
 else:raise RuntimeError('Food resupply exceeded 12 minutes')
except Exception as e:report.update(status='failed',error=str(e))
Path('results/food-resupply-live.json').write_text(json.dumps(report,indent=2))
print(json.dumps({'status':report['status'],'error':report.get('error'),'berries':report.get('after',{}).get('inventory',{}).get('sweet_berries')}),flush=True)
if report['status']!='passed':raise SystemExit(1)
