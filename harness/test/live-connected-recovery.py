"""Live Peaceful drill through the normal model interface, with connection evidence."""
import json,time,urllib.request,subprocess,os,re
from pathlib import Path

def api(route,data=None):
 a=json.loads(Path('state/companion-api.json').read_text())
 return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+route,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
def rcon(command):
 host=os.environ.get('MC_SSH_HOST','');assert re.fullmatch(r'[\w.-]+',host)
 assert "'" not in command
 return subprocess.check_output(['ssh','-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+command+"'"],timeout=15,text=True).strip()
report={'status':'running'};log=Path('state/companion-service.log');offset=log.stat().st_size
try:
 s=api('/state');report['before']=s
 assert s['connected'] and s['phase']=='ready' and s['health']==20
 assert s['inventory'].get('spruce_log',0)<6 and s['connectionId']
 connection=s['connectionId'];assert 'Peaceful' in rcon('difficulty')
 request='Leave the base through its door, collect six spruce logs from natural trees, then retreat inside the lit base and close its door. Preserve all buildings, base storage, carried food and both diamonds. Keep Peaceful difficulty unchanged.'
 report['request']=request;api('/message',{'text':request});fired=False;resumed=False;last_print=0
 for _ in range(1800):
  s=api('/state');rp=s.get('requestProgress') or {};task=s.get('task') or {}
  assert rp.get('request')==request,'Request superseded; ending drill monitor'
  report.setdefault('requestId',rp['id']);assert rp['id']==report['requestId']
  assert s['connected'] and s['connectionId']==connection,'Connection changed during drill'
  if time.time()-last_print>15:
   print(json.dumps({'phase':s['phase'],'task':task.get('kind'),'status':task.get('status'),'health':s['health'],'logs':s['inventory'].get('spruce_log',0),'activity':s.get('activity')}),flush=True);last_print=time.time()
  if not fired and s['phase']=='acting' and task.get('kind')=='gather' and task.get('status')=='running' and s['health']==20:
   o=s['projects']['base']['build']['origin'];p=s['position']
   if ((p['x']-o['x'])**2+(p['z']-o['z'])**2)**.5>=6:
    report['triggerBefore']=s;report['damageResponse']=rcon('damage HarnessRunner 11 minecraft:generic');fired=True
    print('Triggered one nonlethal health drop during active gathering',flush=True)
  safety=s.get('safety') or {}
  if fired and not resumed and safety.get('status') in ['sheltered','failed','cancelled']:
   report['recovery']=s
   assert safety['status']=='sheltered',safety
   assert rp['status']=='interrupted' and s['canResume']
   if s['health']==20:
    api('/resume',{});resumed=True;print('Sheltered on the same connection; resuming the same request',flush=True)
  if resumed and s['phase'] in ['ready','blocked'] and rp['status']!='interrupted':
   report['after']=s
   assert s['phase']=='ready',s['messages'][-1]['text']
   assert s['inventory'].get('spruce_log',0)>=6
   assert s['inventory'].get('diamond')==report['before']['inventory'].get('diamond')
   assert s['inventory'].get('sweet_berries')==report['before']['inventory'].get('sweet_berries')
   assert any(f.get('action')=='retreat' and f.get('result',{}).get('receipt')=='sheltered_door_closed' for f in rp.get('feedback',[]))
   report['status']='passed';break
  if not fired and s['phase'] in ['ready','blocked']:
   raise RuntimeError('Request ended before drill trigger: '+s['messages'][-1]['text'])
  time.sleep(.4)
 else:raise RuntimeError('Drill exceeded 12 minutes')
 assert 'Peaceful' in rcon('difficulty')
 report['serverPosition']=rcon('data get entity HarnessRunner Pos')
 report['serverGamemode']=rcon('data get entity HarnessRunner playerGameType')
 assert report['serverGamemode'].endswith('0')
except Exception as e:
 report['status']='failed';report['error']=str(e)
finally:
 with log.open('rb') as f:f.seek(offset);lines=f.read().decode(errors='replace').splitlines()
 events=[]
 for line in lines:
  try:e=json.loads(line)
  except ValueError:continue
  if e.get('type') in ['connecting','spawn','disconnected','reconnecting','skill_cancelling','skill_cancelled','task_started','task_finished']:events.append(e)
 report['events']=events
 if any(e['type'] in ['connecting','spawn','disconnected','reconnecting'] for e in events):report.update(status='failed',error='Connection lifecycle event during drill')
 Path('results/connected-recovery-live.json').write_text(json.dumps(report,indent=2))
 print(json.dumps({'status':report['status'],'error':report.get('error'),'sameConnection':report.get('after',{}).get('connectionId')==report.get('before',{}).get('connectionId')}),flush=True)
if report['status']!='passed':raise SystemExit(1)
