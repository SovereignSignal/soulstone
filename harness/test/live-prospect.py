import json,time,urllib.request
from pathlib import Path
a=json.loads(Path('state/companion-api.json').read_text())
def request(path,payload=None):
 return json.load(urllib.request.urlopen(urllib.request.Request(a['url']+path,data=None if payload is None else json.dumps(payload).encode(),headers={'Authorization':'Bearer '+a['token'],'Content-Type':'application/json'}),timeout=8))
message='Continue getting one diamond. Use the saved base and verify that you carry it when you return.'
print(request('/message',{'text':message}),flush=True)
last=None;started=time.time()
while time.time()-started<1500:
 state=request('/state');Path('results/live-prospect-latest.json').write_text(json.dumps(state,indent=2))
 small={k:state.get(k) for k in ['phase','activity','position','inventory']};small['progress']=state.get('task',{}).get('progress');small['message']=state.get('messages',[])[-1]['text']
 signature=json.dumps({k:v for k,v in small.items() if k not in ['position','progress']})
 if signature!=last:print(json.dumps(small),flush=True);last=signature
 if state['phase'] not in ['thinking','acting']:
  Path('results/live-prospect-after.json').write_text(json.dumps(state,indent=2));print('REQUEST_ENDED',flush=True);break
 time.sleep(3)
