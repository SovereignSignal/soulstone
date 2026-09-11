"""Resume one saved diamond request and record it without intervening in play.

Use only with the user's authorization. No resource grants, world edits, model
changes or automatic retries. The app's Stop and safety controls remain active.
"""
import argparse, json, time, urllib.request
from pathlib import Path

parser=argparse.ArgumentParser()
parser.add_argument('state_dir',type=Path)
args=parser.parse_args()
endpoint=json.loads((args.state_dir/'companion-api.json').read_text())
output=Path(__file__).resolve().parents[1]/'results'/f'diamond-persistence-{time.time_ns()//1000000}'
output.mkdir()
def request(path,payload=None):
    req=urllib.request.Request(endpoint['url']+path,data=None if payload is None else json.dumps(payload).encode(),headers={'Authorization':'Bearer '+endpoint['token'],'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=8) as response:return json.load(response)
before=request('/state');saved=before.get('requestProgress') or {}
assert before['connected'] and not before['dead'] and before['canResume']
assert 'diamond' in json.dumps(saved.get('goal',{})).lower()
assert before.get('inventory',{}).get('diamond',0)==0
(output/'before.json').write_text(json.dumps(before,indent=2))
print(json.dumps({'directory':str(output),'requestId':saved['id'],'initialInventory':before['inventory']}),flush=True)
request('/resume',{})
started=time.monotonic();last=None
try:
    while time.monotonic()-started<3000:
        state=request('/state');progress=state.get('requestProgress') or {}
        assert progress.get('id')==saved['id'],'User changed the request; monitoring ends without touching it'
        (output/'latest.json').write_text(json.dumps(state,indent=2))
        compact={k:state.get(k) for k in ['phase','activity','inventory','health','position']}
        compact.update(status=progress.get('status'),rounds=progress.get('rounds'),blocker=progress.get('blocker'))
        signature=json.dumps({k:v for k,v in compact.items() if k!='position'},sort_keys=True)
        if signature!=last:print(json.dumps(compact),flush=True);last=signature
        if progress.get('status')!='running' and state['phase'] not in ['thinking','acting','retreating','defending']:
            (output/'after.json').write_text(json.dumps(state,indent=2))
            print(json.dumps({'ended':True,'path':str(output/'after.json'),'status':progress.get('status'),'diamond':state['inventory'].get('diamond',0),'elapsedSeconds':round(time.monotonic()-started,1)}),flush=True)
            break
        time.sleep(3)
    else:
        request('/stop',{})
        raise TimeoutError('Fifty-minute observer bound reached; operator Stop issued and progress retained')
except Exception as error:
    (output/'monitor-error.json').write_text(json.dumps({'error':str(error),'elapsedSeconds':time.monotonic()-started},indent=2))
    raise
