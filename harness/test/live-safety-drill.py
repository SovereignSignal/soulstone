"""One nonlethal health drill in the authorized Peaceful lab; never changes difficulty."""
import json,time,urllib.request,subprocess,os,re
from pathlib import Path
def api(route,data=None):
 a=json.loads(Path('state/companion-api.json').read_text())
 return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+route,data=None if data is None else json.dumps(data).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
def rcon(command):
 host=os.environ.get('MC_SSH_HOST','');assert re.fullmatch(r'[\w.-]+',host)
 assert "'" not in command
 return subprocess.check_output(['ssh','-o','BatchMode=yes',host,"sudo docker exec mc-sandbox rcon-cli '"+command+"'"],timeout=15,text=True).strip()
s=api('/state');assert s['connected'] and (s['phase']=='ready' or os.environ.get('MC_RESUME_DRILL')=='1' and s.get('canResume')) and s['health']==20 and s['inventory'].get('sweet_berries',0)>=12
assert 'Peaceful' in rcon('difficulty')
Path('results/safety-drill-before.json').write_text(json.dumps(s,indent=2))
request='Leave the base through its door, harvest until you carry at least 32 sweet berries without breaking the bushes, then retreat into the lit base and close its door. Preserve all buildings, tools and both diamonds. Keep Peaceful difficulty unchanged.'
print(api('/resume',{}) if os.environ.get('MC_RESUME_DRILL')=='1' else api('/message',{'text':request}),flush=True);started=time.time();fired=False;report={'status':'running','request':request}
while time.time()-started<600:
 s=api('/state');task=s.get('task') or {};rp=s.get('requestProgress') or {}
 assert rp.get('request')==request,'User superseded drill; stopping monitor'
 if not fired and s['connected'] and s['phase']=='acting' and task.get('kind')=='harvest' and task.get('status')=='running' and s['health']==20:
  o=s['projects']['base']['build']['origin'];p=s['position']
  if ((p['x']-o['x'])**2+(p['z']-o['z'])**2)**.5>=6:
   report['triggerBefore']=s;report['damageCommand']='damage HarnessRunner 11 minecraft:generic'
   report['damageResponse']=rcon(report['damageCommand']);fired=True;print('HEALTH DRILL TRIGGERED '+report['damageResponse'],flush=True)
 if fired and (s.get('safety') or {}).get('status') in ['sheltered','failed','cancelled']:
  report['after']=s;report['status']='passed' if s['safety']['status']=='sheltered' and rp['status']=='interrupted' and s['canResume'] else 'failed';break
 if not fired and s['phase'] in ['blocked','ready'] and time.time()-started>5:
  report.update(status='failed',error='Request ended before a safe drill trigger',after=s);break
 time.sleep(.4 if s['phase']=='acting' or fired else 2)
else:report.update(status='failed',error='Drill timeout')
Path('results/safety-drill.json').write_text(json.dumps(report,indent=2));print(json.dumps({'status':report['status'],'fired':fired,'safety':report.get('after',{}).get('safety'),'phase':report.get('after',{}).get('phase'),'canResume':report.get('after',{}).get('canResume')}),flush=True)
if report['status']!='passed':raise SystemExit(1)
