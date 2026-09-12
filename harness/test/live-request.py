"""Send one request (or resume the saved one) to a running companion service and
record the run without intervening. Generalizes live-diamond-persistence.py.

Use only with the user's authorization: the request spends model calls and moves,
mines or builds in the connected world. No resource grants, world edits, model
changes or automatic retries. The service's Stop and safety controls stay active.

  python3 test/live-request.py <state_dir> --name gather-check --message "Gather ..."
  python3 test/live-request.py <state_dir> --name diamond --resume [--bound 3000]
"""
import argparse, json, time, urllib.request
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('state_dir',type=Path)
parser.add_argument('--name',required=True,help='results/<name>-<ms>/ receipt directory')
group=parser.add_mutually_exclusive_group(required=True)
group.add_argument('--message',help='new request text sent to POST /message')
group.add_argument('--resume',action='store_true',help='POST /resume the saved request')
parser.add_argument('--bound',type=float,default=1800,help='seconds before the observer issues Stop')
args=parser.parse_args()
endpoint=json.loads((args.state_dir/'companion-api.json').read_text())
output=Path(__file__).resolve().parents[1]/'results'/f'{args.name}-{time.time_ns()//1000000}'
output.mkdir()
def request(path,payload=None):
    req=urllib.request.Request(endpoint['url']+path,data=None if payload is None else json.dumps(payload).encode(),headers={'Authorization':'Bearer '+endpoint['token'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=8) as response:return json.load(response)
before=request('/state')
assert before['connected'] and not before['dead'],'bot must be connected and alive'
if args.resume:assert before.get('canResume'),'nothing to resume'
(output/'before.json').write_text(json.dumps(before,indent=2))
if args.resume:request('/resume',{});expected=(before.get('requestProgress') or {}).get('id')
else:request('/message',{'text':args.message});expected=None
print(json.dumps({'directory':str(output),'mode':'resume' if args.resume else 'message','initialInventory':before['inventory']}),flush=True)
started=time.monotonic();last=None
try:
    while time.monotonic()-started<args.bound:
        state=request('/state');progress=state.get('requestProgress') or {}
        if expected is None and progress.get('id'):expected=progress['id']
        assert expected is None or progress.get('id')==expected,'Request changed under the observer; monitoring ends without touching it'
        (output/'latest.json').write_text(json.dumps(state,indent=2))
        compact={k:state.get(k) for k in ['phase','activity','inventory','health','position']}
        compact.update(status=progress.get('status'),rounds=progress.get('rounds'),blocker=progress.get('blocker'))
        signature=json.dumps({k:v for k,v in compact.items() if k!='position'},sort_keys=True)
        if signature!=last:print(json.dumps(compact),flush=True);last=signature
        settled=progress.get('status') not in (None,'running') and state['phase'] not in ['thinking','acting','retreating','defending']
        if settled and time.monotonic()-started>6:
            (output/'after.json').write_text(json.dumps(state,indent=2))
            print(json.dumps({'ended':True,'path':str(output/'after.json'),'status':progress.get('status'),'inventory':state['inventory'],'elapsedSeconds':round(time.monotonic()-started,1)}),flush=True)
            break
        time.sleep(3)
    else:
        request('/stop',{})
        raise TimeoutError(f'{args.bound:.0f}s observer bound reached; operator Stop issued and progress retained')
except Exception as error:
    (output/'monitor-error.json').write_text(json.dumps({'error':str(error),'elapsedSeconds':time.monotonic()-started},indent=2))
    raise
