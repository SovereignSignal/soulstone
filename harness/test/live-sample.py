"""Drive one request against a running companion service and sample its state.

Modes: --message "text" sends a new request; --resume resumes the saved one;
--watch attaches to whatever request is running. Every five seconds a row with
phase, activity, task, health, food, time of day, nearby threats, position,
deadline headroom and request status is appended to results/<name>-<ms>/samples.jsonl;
before.json and after.json bracket the run. Use only with the user's
authorization: a request spends model calls and acts in the connected world.

  python3 test/live-sample.py <state dir> --name fresh --message "Build us a shelter"
  python3 test/live-sample.py <state dir> --name diamond --resume --bound 5400
"""
import argparse, json, time, urllib.request
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('state_dir',type=Path)
parser.add_argument('--name',required=True)
group=parser.add_mutually_exclusive_group(required=True)
group.add_argument('--message')
group.add_argument('--resume',action='store_true')
group.add_argument('--watch',action='store_true')
parser.add_argument('--bound',type=float,default=3600,help='seconds before the observer issues Stop')
parser.add_argument('--interval',type=float,default=5)
args=parser.parse_args()
ep=json.loads((args.state_dir/'companion-api.json').read_text())
out=Path(__file__).resolve().parents[1]/'results'/f'{args.name}-{time.time_ns()//1000000}';out.mkdir()
def req(path,payload=None):
    r=urllib.request.Request(ep['url']+path,data=None if payload is None else json.dumps(payload).encode(),headers={'Authorization':'Bearer '+ep['token'],'Content-Type':'application/json'})
    with urllib.request.urlopen(r,timeout=8) as x:return json.load(x)
before=req('/state');assert before['connected'],'not connected'
(out/'before.json').write_text(json.dumps(before,indent=2))
rid=None
if args.watch:rid=(before.get('requestProgress') or {}).get('id')
elif args.resume:
    assert before.get('canResume'),'not resumable'
    rid=(before.get('requestProgress') or {}).get('id');req('/resume',{})
else:req('/message',{'text':args.message})
print(json.dumps({'dir':str(out),'mode':'watch' if args.watch else 'resume' if args.resume else 'message','requestId':rid,'inventory':before['inventory']}),flush=True)
t0=time.monotonic();last=None;minute=-1
with (out/'samples.jsonl').open('w') as f:
    while time.monotonic()-t0<args.bound:
        try:s=req('/state')
        except Exception as e:print('sample error',e,flush=True);time.sleep(args.interval);continue
        now=time.time()*1000;t=s.get('task') or {};p=s.get('requestProgress') or {};pr=t.get('progress') or {};sv=s.get('survival') or {};pos=s.get('position')
        if rid is None and p.get('id'):rid=p['id']
        row={'t':round(time.monotonic()-t0),'phase':s.get('phase'),'activity':s.get('activity'),'task':t.get('kind'),'status':t.get('status'),'progress':pr or None,'health':s.get('health'),'food':sv.get('food'),'tod':sv.get('timeOfDay'),
             'threats':[f"{x.get('name')}@{x.get('distance')}:{(x.get('risk') or '?')[0]}" for x in sv.get('nearbyThreats') or []][:4],'pos':pos and [round(pos['x']),round(pos['y']),round(pos['z'])],
             'idleLeft':round((t['deadline']-now)/1000) if t.get('deadline') else None,'ceilLeft':round((t['hardDeadline']-now)/1000) if t.get('hardDeadline') else None,
             'rounds':p.get('rounds'),'reqStatus':p.get('status'),'blocker':p.get('blocker'),'safety':(s.get('safety') or {}).get('status'),'diamond':s.get('inventory',{}).get('diamond',0)}
        f.write(json.dumps(row)+'\n');f.flush()
        key=(row['phase'],row['activity'],row['task'],row['status'],row['blocker'],row['reqStatus'],row['safety'],row['diamond'])
        m=row['t']//60
        if key!=last or m!=minute:print(json.dumps(row),flush=True);last=key;minute=m
        if rid and p.get('id')!=rid and p.get('id'):print('request changed; observer stops',flush=True);break
        # Keep following while safety is dug in or fighting: the request continues on its own afterwards.
        sheltering=(s.get('safety') or {}).get('status') in ('burrowed','retreating','defending')
        settled=p.get('status') not in (None,'running') and s.get('phase') not in ('thinking','acting','retreating','defending') and not sheltering
        if settled and time.monotonic()-t0>10:break
        time.sleep(args.interval)
    else:
        req('/stop',{});print('STOP issued at bound',flush=True)
time.sleep(3);after=req('/state');(out/'after.json').write_text(json.dumps(after,indent=2))
print(json.dumps({'ended':True,'reqStatus':(after.get('requestProgress') or {}).get('status'),'blocker':(after.get('requestProgress') or {}).get('blocker'),'inventory':after['inventory'],'elapsed':round(time.monotonic()-t0)}),flush=True)
