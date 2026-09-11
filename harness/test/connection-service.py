"""Verify the actual companion HTTP retry path against a closed local port.

Uses an isolated profile, no Minecraft world and no model inference.
"""
import json, os, shutil, subprocess, tempfile, time, urllib.request, urllib.error
from pathlib import Path

harness = Path(__file__).resolve().parents[1]

with tempfile.TemporaryDirectory(prefix='soul-connection-') as temp:
    root = Path(temp)
    profile = dict(host='127.0.0.1', port=1, owner='TestPlayer', username='SoulTest',
                   auth='offline', version='auto', provider='codex', model='gpt-6-astra')
    (root/'setup.json').write_text(json.dumps(profile))
    env = dict(HOME=temp, PATH='/usr/bin:/bin', TMPDIR=temp,
               MC_SETUP_FILE=str(root/'setup.json'), MC_RECORD_EPISODES='0')
    with (root/'service.log').open('w') as log:
        process = subprocess.Popen([shutil.which('node'), str(harness/'src/companion/server.js')],
                                   cwd=root, env=env, stdout=log, stderr=log)
        try:
            endpoint = root/'state/companion-api.json'
            deadline = time.monotonic()+10
            while not endpoint.exists():
                assert process.poll() is None, 'Isolated backend exited during startup'
                assert time.monotonic()<deadline, 'Isolated startup timed out'
                time.sleep(.1)
            info = json.loads(endpoint.read_text())

            def request(path, method='GET', authenticated=True):
                headers = {'Authorization':'Bearer '+info['token']} if authenticated else {}
                req = urllib.request.Request(info['url']+path, headers=headers, method=method,
                                             data=b'{}' if method=='POST' else None)
                try:
                    with urllib.request.urlopen(req, timeout=3) as response:
                        return response.status, json.load(response)
                except urllib.error.HTTPError as error:
                    return error.code, json.load(error)

            assert request('/reconnect','POST',False)[0]==403
            initial = request('/state')[1]
            for _ in range(3): assert request('/reconnect','POST')[0]==202
            assert request('/state')[1]['connectionId']==initial['connectionId'], 'Duplicate connection during pending retry'
            deadline = time.monotonic()+45
            while True:
                state = request('/state')[1]
                if 'attempts stopped' in (state.get('connectionIssue') or ''): break
                assert time.monotonic()<deadline, 'Retry exhaustion did not appear in the API'
                time.sleep(.2)
            exhausted = state['connectionId']
            assert request('/reconnect','POST')[0]==202
            retried = request('/state')[1]
            assert retried['connectionId']!=exhausted, 'Reconnect did not create a fresh attempt'
            for _ in range(3): assert request('/reconnect','POST')[0]==202
            assert request('/state')[1]['connectionId']==retried['connectionId'], 'Duplicate connection after manual retry'
            assert retried['task'] is None and retried['requestProgress'] is None and retried['plan']==[]
            text = (root/'service.log').read_text()
            assert 'task_started' not in text
            print(json.dumps(dict(status='passed', unauthorizedRejected=True,
                                  pendingRetriesNotDuplicated=True, exhaustionObserved=True,
                                  manualRetryCreatedNewConnection=True, noTaskDispatched=True), indent=2))
        finally:
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
