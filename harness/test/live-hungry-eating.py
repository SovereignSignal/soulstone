"""Bounded hunger-only lab drill. Restores Peaceful even when acceptance fails."""
import json,time,urllib.request,subprocess,os,re,signal
from pathlib import Path

def api(route,data=None):
 a=json.loads(Path('state/companion-api.json').read_text())
 return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+route,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
def rcon(command):
 host=os.environ.get('MC_SSH_HOST','');assert re.fullmatch(r'[\w.-]+',host)
 assert "'" not in command
 return subprocess.check_output(['ssh','-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+command+"'"],timeout=15,text=True).strip()
def interrupted(*_):raise RuntimeError('Drill interrupted; restoring lab settings')
signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
report={'status':'running','samples':[]};changed=False;objective=False;effect=False
try:
 s=api('/state');report['before']=s
 assert s['connected'] and s['phase']=='ready' and s['health']==20 and not s.get('safety')
 assert s['survival']['food']==20 and s['inventory'].get('sweet_berries',0)>=16
 assert abs(s['position']['x']+590.5)<1 and abs(s['position']['z']+297.5)<1
 connection=s['connectionId'];request_id=s['requestProgress']['id']
 assert 'Peaceful' in rcon('difficulty')
 assert 'false' in rcon('gamerule doMobSpawning')
 assert 'false' in rcon('gamerule doDaylightCycle')
 assert 'harness_food' not in rcon('scoreboard objectives list')
 rcon('scoreboard objectives add harness_food minecraft.used:minecraft.sweet_berries');objective=True
 report['scoreBefore']=rcon('scoreboard players get HarnessRunner harness_food')
 changed=True;rcon('difficulty easy');effect=True
 report['stimulus']=rcon('effect give HarnessRunner minecraft:hunger 10 255 true')
 started=time.monotonic();cleared=False
 while time.monotonic()-started<45:
  s=api('/state');assert s['connected'] and s['connectionId']==connection,'Connection changed'
  assert s['requestProgress']['id']==request_id,'User superseded test'
  sample={'elapsed':round(time.monotonic()-started,2),'food':s['survival']['food'],'health':s['health'],'berries':s['inventory'].get('sweet_berries',0),'phase':s['phase'],'safety':(s.get('safety') or {}).get('status'),'task':(s.get('task') or {}).get('kind')}
  if not report['samples'] or sample['food']!=report['samples'][-1]['food'] or sample['berries']!=report['samples'][-1]['berries'] or sample['phase']!=report['samples'][-1]['phase']:
   report['samples'].append(sample);print(json.dumps(sample),flush=True)
  if s['survival']['food']<=6 and not cleared:
   report['lowFood']=s;report['clearEffect']=rcon('effect clear HarnessRunner minecraft:hunger');effect=False;cleared=True
  safety=s.get('safety') or {}
  if safety.get('status') in ['failed','cancelled']:raise RuntimeError(str(safety))
  if safety.get('status')=='sheltered':
   report['afterEating']=s
   eaten=safety.get('eating') or {};assert eaten.get('receipt')=='food_consumption_verified',eaten
   assert eaten['count']>0 and len(eaten['consumed'])==eaten['count']
   assert report['before']['inventory']['sweet_berries']-s['inventory']['sweet_berries']==eaten['count']
   assert all(c['after']['count']==c['before']['count']-1 and c['after']['food']>c['before']['food'] for c in eaten['consumed'])
   report['scoreAfter']=rcon('scoreboard players get HarnessRunner harness_food')
   assert int(re.search(r'has (\d+)',report['scoreAfter']).group(1))==eaten['count']
   report['serverBerries']=rcon('data get entity HarnessRunner Inventory[{id:"minecraft:sweet_berries"}].count')
   assert int(re.search(r'entity data: (\d+)',report['serverBerries']).group(1))==s['inventory']['sweet_berries']
   report['status']='passed';break
  time.sleep(.15)
 else:raise RuntimeError('Hunger drill timed out after 45 seconds')
except Exception as e:report.update(status='failed',error=str(e))
finally:
 cleanup=[]
 for needed,command in [(effect,'effect clear HarnessRunner minecraft:hunger'),(changed,'difficulty peaceful'),(objective,'scoreboard objectives remove harness_food')]:
  if needed:
   try:cleanup.append({'command':command,'response':rcon(command)})
   except Exception as e:report.update(status='failed',cleanupError=str(e))
 report['cleanup']=cleanup
 try:report['finalDifficulty']=rcon('difficulty');assert 'Peaceful' in report['finalDifficulty']
 except Exception as e:report.update(status='failed',cleanupError=str(e))
 Path('results/hungry-eating-live.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({'status':report['status'],'error':report.get('error'),'finalDifficulty':report.get('finalDifficulty')}),flush=True)
if report['status']!='passed':raise SystemExit(1)
