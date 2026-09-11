"""Reload the backend service without requiring the native UI to be unlocked."""
import json,os,signal,time,subprocess,shutil,urllib.request
from pathlib import Path
a=json.loads(Path('state/companion-api.json').read_text());s=json.load(urllib.request.urlopen(urllib.request.Request(a['url']+'/state',headers={'Authorization':'Bearer '+a['token']}),timeout=8));assert s['phase'] in ['ready','blocked']
os.kill(a['pid'],signal.SIGTERM)
for i in range(100):
 try:os.kill(a['pid'],0)
 except ProcessLookupError:break
 time.sleep(.1)
else:raise RuntimeError('Old backend has not stopped; no duplicate started')
with open('state/companion-service.log','ab') as log:
 p=subprocess.Popen([shutil.which('node'),'--env-file-if-exists=.env','src/companion/server.js'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
print('Backend restarted with preserved state:',p.pid)
