"""One natural-world request; no server commands, resources, resets or retries."""
import json,time,urllib.request
from pathlib import Path
root=Path(__file__).resolve().parents[1]
def call(path,body=None):
    a=json.loads((root/'state/companion-api.json').read_text())
    request=urllib.request.Request(a['url']+path,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'})
    return json.load(urllib.request.urlopen(request,timeout=8))
before=call('/state')
assert before['phase']=='ready','Existing work must finish first'
assert before['model']=='gpt-6-astra' and before['modelReady']
request='Prepare supplies for a mining trip: make two serviceable iron pickaxes, gather eight coal, stock our base chest with the coal and spare excavation materials, and return to base ready for my next command. Keep tools, torches and the diamond.'
report={'scope':'One Astra request in existing natural terrain; no supplied resources or world/inventory reset','request':request,'before':before}
(root/'results/live-supplies-before.json').write_text(json.dumps(report,indent=2))
call('/message',{'text':request})
started=time.time();last=None
for i in range(1800):
    state=call('/state');key=(state['phase'],state['activity'],len(state['messages']))
    if key!=last:
        print(json.dumps({'elapsed':round(time.time()-started),'phase':state['phase'],'activity':state['activity'],'last':state['messages'][-1]['text'] if state['messages'] else ''}),flush=True);last=key
    (root/'results/live-supplies-latest.json').write_text(json.dumps(state,indent=2))
    if state.get('requestProgress',{}).get('request')!=request:
        raise RuntimeError('A new user request superseded this acceptance run; no replay')
    if state['phase'] not in ('thinking','acting'):
        report.update({'elapsedSeconds':time.time()-started,'after':state,'status':'executor_finished' if state['phase']=='ready' else 'blocked'})
        (root/'results/live-supplies-after.json').write_text(json.dumps(report,indent=2))
        print(json.dumps({'status':report['status'],'elapsed':report['elapsedSeconds'],'inventory':state['inventory']}),flush=True)
        break
    time.sleep(1)
else:
    call('/stop');raise RuntimeError('Acceptance deadline reached; bot stopped')
