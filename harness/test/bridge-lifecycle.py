import subprocess, json, time, socket, select, pathlib
results=[]
for mode in ['close','parent_crash']:
    worker=subprocess.Popen(['node','test/bridge-lifecycle-worker.js'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        if not select.select([worker.stdout],[],[],35)[0]: raise RuntimeError('Helper startup timed out')
        line=worker.stdout.readline()
        if not line: raise RuntimeError('Helper startup failed')
        identity=json.loads(line)
        if mode=='close': worker.stdin.write('close\n');worker.stdin.flush();worker.wait(timeout=8)
        else: worker.kill();worker.wait(timeout=5)
        closed=False
        for _ in range(50):
            try:
                with socket.create_connection(('127.0.0.1',identity['port']),timeout=.1): pass
            except OSError: closed=True;break
            time.sleep(.1)
        if not closed: raise AssertionError('Orphan bridge listener remained')
        results.append({'mode':mode,'listenerClosed':closed})
    finally:
        if worker.poll() is None: worker.kill();worker.wait()
pathlib.Path('results/bridge-lifecycle.json').write_text(json.dumps(results,indent=2)+'\n')
print(json.dumps(results))
