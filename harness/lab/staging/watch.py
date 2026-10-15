"""Bounded watch of one request in the test world (MC_CONTAINER, MC_BOT; defaults mc-sandbox, SoulStone303).

Posts exactly one request to the running soulstone-agent, samples its state
once a second, and stops the request (never the agent, bridge or server) on
death, portal or dimension entry, disconnection, a terminal request or the cap.
With --allow-nether (test world only) the
run carries on through a portal and in the Nether, and stops only on the End;
--allow-end (test world only) lets it carry on in the End too.
Reads the companion API only, plus read-only server receipts at the end.
"""
from pathlib import Path
import json,os,subprocess,importlib.util,time,signal,sys
from datetime import datetime,timezone
ROOT=Path(os.environ.get('SOULSTONE_ROOT',Path.home()/'soulstone'));RUN=Path(os.environ.get('SOULSTONE_RUN',ROOT/'run'))
CONTAINER=os.environ.get('MC_CONTAINER','mc-sandbox');BOT=os.environ.get('MC_BOT','SoulStone303');ALLOW_NETHER='--allow-nether' in sys.argv;ALLOW_END='--allow-end' in sys.argv;ARGS=[a for a in sys.argv[1:] if a not in ('--allow-nether','--allow-end')];
if (ALLOW_NETHER or ALLOW_END) and RUN.resolve()!=(ROOT/'run').resolve():sys.exit(f'--allow-nether and --allow-end run only against the test bot: set SOULSTONE_RUN={ROOT/"run"}')
sys.path.insert(0,str(Path(__file__).resolve().parent));from watch_stops import dimension_stop
OUT=Path(ARGS[0]);MINUTES=float(ARGS[1]);REQUEST=ARGS[2]
OUT.mkdir(parents=True,exist_ok=False)
spec=importlib.util.spec_from_file_location('score',ROOT/'harness/test/rung-score.py');score=importlib.util.module_from_spec(spec);spec.loader.exec_module(score)
now=lambda:datetime.now(timezone.utc).isoformat()
def halt(*_):raise KeyboardInterrupt()
signal.signal(signal.SIGTERM,halt)
def rcon(command):
 try:return subprocess.check_output(['docker','exec',CONTAINER,'rcon-cli',command],text=True,timeout=10).strip()
 except Exception as exc:return 'error: '+str(exc)
api=None;last={};previous=None;deaths=score.DeathCounter();reason='setup_failed';posted=False;started=now()
try:
 api=score.CompanionApi(RUN/'state',timeout=15);last=api.call('/state',retries=2)
 s=last.get('survival')or{}
 assert last.get('connected') and last.get('modelReady') and not last.get('dead'),'agent not ready'
 assert (last.get('requestProgress')or{}).get('status')!='running' and (last.get('safety')or{}).get('status') in (None,'cancelled','sheltered','burrowed'),'agent is not idle'
 assert dimension_stop(s,allow_nether=ALLOW_NETHER,allow_end=ALLOW_END) is None,'not starting where this watch allows (the Overworld outside a portal, unless a flag allows more)'
 (OUT/'preflight.json').write_text(json.dumps({'at':now(),'state':last,'server':{c:rcon(c) for c in ['list','difficulty','gamerule minecraft:advance_time',f'data get entity {BOT} Health']},'request':REQUEST,'allowNether':ALLOW_NETHER,'allowEnd':ALLOW_END,'limitMinutes':MINUTES},indent=1))
 previous=(last.get('requestProgress')or{}).get('id')
 deaths.observe(last);started=now();deadline=time.monotonic()+MINUTES*60;last_ok=time.monotonic()
 api.call('/message',{'text':REQUEST},retries=1);posted=True
 print(json.dumps({'started':started,'limitMinutes':MINUTES,'posted':posted}),flush=True)
 reason='time_limit'
 with (OUT/'watch.jsonl').open('w') as log:
  while time.monotonic()<deadline:
   try:
    last=api.call('/state',retries=1);last_ok=time.monotonic();deaths.observe(last);s=last.get('survival')or{};p=last.get('requestProgress')or{};task=last.get('task')or{};safety=last.get('safety')or None
    log.write(json.dumps({'at':now(),'phase':last.get('phase'),'health':last.get('health'),'hunger':s.get('food'),'position':last.get('position'),'connected':last.get('connected'),'dead':last.get('dead'),'deaths':deaths.deaths,
     'status':p.get('status'),'rounds':p.get('rounds'),'completed':len(p.get('completed')or[]),'task':{'kind':task.get('kind'),'status':task.get('status')},
     'safety':safety and {'status':safety.get('status'),'reason':safety.get('reason')},
     'threats':[[t.get('name'),t.get('distance'),t.get('verticalOffset'),(t.get('sightline')or{}).get('status')] for t in (s.get('nearbyThreats')or[]) if t.get('risk')=='potential_hostile'],
     'inventory':last.get('inventory')})+'\n');log.flush()
    if deaths.deaths or last.get('dead'):reason='death';break
    stop=dimension_stop(s,allow_nether=ALLOW_NETHER,allow_end=ALLOW_END)
    if stop:reason=stop;break
    if not last.get('connected'):
     if time.monotonic()-last_ok>15:reason='disconnected';break
    # The saved request from before this run is already terminal; only the new one ends the watch.
    if p.get('id')!=previous and score.is_terminal(p):reason=score.terminal_reason(p);break
   except Exception as exc:
    if time.monotonic()-last_ok>20:reason='state_unavailable:'+type(exc).__name__;break
   time.sleep(1)
except KeyboardInterrupt:reason='watcher_interrupted'
except Exception as exc:reason='error:'+type(exc).__name__+':'+str(exc)
finally:
 stopped=None
 try:
  if api and posted:
   last=api.call('/state',retries=1);(OUT/'after.json').write_text(json.dumps(last,indent=1))
   p=last.get('requestProgress')or{}
   # A finished request needs no Stop; anything still running must not continue unwatched.
   # Not after a death: the bot pauses its own request when it dies, and a Stop would hold its
   # safety off for a minute while it respawns (lab run 135: killed by a zombie at the spawn).
   if reason!='death' and (p.get('id')==previous or not score.is_terminal(p)):api.call('/stop',{},retries=1);stopped=True
 except Exception as exc:(OUT/'final-read-error.txt').write_text(str(exc))
 server={c:rcon(c) for c in [f'data get entity {BOT} Health',f'data get entity {BOT} foodLevel',f'data get entity {BOT} Dimension',f'data get entity {BOT} Pos']}
 report={'started':started,'ended':now(),'reason':reason,'posted':posted,'stoppedRequest':stopped,'deaths':deaths.deaths,'health':last.get('health'),'position':last.get('position'),'inventory':last.get('inventory'),
  'requestStatus':(last.get('requestProgress')or{}).get('status'),'rounds':(last.get('requestProgress')or{}).get('rounds'),'server':server}
 (OUT/'watch-result.json').write_text(json.dumps(report,indent=1));print(json.dumps({'ended':report['ended'],'reason':reason,'deaths':deaths.deaths}),flush=True)
