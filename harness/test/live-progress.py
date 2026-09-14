"""Measure whether one continuing world actually progresses.

From wherever the agent is now, run one instruction and record the milestones
that matter for accumulation: tools kept, food eaten, armour worn, a lit
shelter verified, a night survived, and anything lost to a death. Observation
only: no resource grants, no world edits, no automatic retries.
"""
import argparse, json, time, urllib.request
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('state_dir', type=Path)
parser.add_argument('--message', required=True)
parser.add_argument('--minutes', type=float, default=45)
parser.add_argument('--interval', type=float, default=10)
args = parser.parse_args()

endpoint = json.loads((args.state_dir / 'companion-api.json').read_text())
out = Path(__file__).resolve().parents[1] / 'results' / f'progress-{time.strftime("%Y%m%d-%H%M%S")}'
out.mkdir(parents=True)

def call(path, payload=None):
    req = urllib.request.Request(endpoint['url'] + path,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={'Authorization': 'Bearer ' + endpoint['token'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)

ARMOUR = ('_helmet', '_chestplate', '_leggings', '_boots')
TOOLS = ('_pickaxe', '_axe', '_shovel', '_sword', '_hoe')
FOOD = ('beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'bread', 'apple', 'carrot', 'potato',
        'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_cod', 'cooked_salmon', 'sweet_berries')

def snapshot(s):
    inv = s.get('inventory') or {}
    base = (s.get('projects') or {}).get('base') or {}
    return {
        'health': s.get('health'), 'hunger': (s.get('survival') or {}).get('food'),
        'tools': sorted(k for k in inv if k.endswith(TOOLS)),
        'armour': sorted(k for k in inv if k.endswith(ARMOUR)),
        'food': {k: v for k, v in inv.items() if k in FOOD},
        'torches': inv.get('torch', 0), 'chest': 'chest' in (base.get('stations') or {}),
        'litBase': ((base.get('stations') or {}).get('torch') or {}).get('confirmed') is True,
        'baseOrigin': (base.get('build') or {}).get('origin'),
        'inventoryCount': sum(inv.values()) if inv else 0,
    }

before = call('/state')
assert before['connected'], 'bot is not connected'
start = snapshot(before)
(out / 'before.json').write_text(json.dumps(before, indent=2))
print(json.dumps({'dir': str(out), 'start': start}), flush=True)

call('/message', {'text': args.message})
deadline = time.monotonic() + args.minutes * 60
milestones, deaths, nights, last_tod, last_sig = [], 0, 0, None, None

def note(kind, detail):
    milestones.append({'at': round(time.monotonic() - (deadline - args.minutes * 60), 1), 'kind': kind, 'detail': detail})
    print(json.dumps(milestones[-1]), flush=True)

while time.monotonic() < deadline:
    try:
        s = call('/state')
    except Exception as error:
        print(json.dumps({'poll_error': str(error)}), flush=True); time.sleep(args.interval); continue
    now = snapshot(s)
    tod = (s.get('survival') or {}).get('timeOfDay')
    if last_tod is not None and tod is not None and tod < last_tod:
        nights += 1; note('night_survived', {'count': nights, 'health': now['health']})
    last_tod = tod
    if s.get('dead'):
        deaths += 1; note('death', {'position': s.get('position'), 'lost': now['inventoryCount']})
        call('/respawn', {}); time.sleep(8); continue
    for key in ('tools', 'armour'):
        gained = sorted(set(now[key]) - set(start[key]))
        if gained and not any(m['kind'] == key and m['detail'] == gained for m in milestones):
            note(key, gained)
    if now['litBase'] and not start['litBase'] and not any(m['kind'] == 'lit_base' for m in milestones):
        note('lit_base', now['baseOrigin'])
    if now['chest'] and not start['chest'] and not any(m['kind'] == 'chest' for m in milestones):
        note('chest', now['baseOrigin'])
    sig = json.dumps([now['tools'], now['armour'], sorted(now['food']), now['litBase'], now['chest']])
    if sig != last_sig:
        (out / 'latest.json').write_text(json.dumps({'snapshot': now, 'milestones': milestones}, indent=2)); last_sig = sig
    status = (s.get('requestProgress') or {}).get('status')
    if status in ('completed', 'needs_review') and not any(m['kind'] == 'request_' + status for m in milestones):
        note('request_' + status, (s.get('requestProgress') or {}).get('rounds'))
    time.sleep(args.interval)

end = call('/state')
final = snapshot(end)
scored = {
    'food': bool(final['food']), 'tools': len(final['tools']) >= 2, 'armour': bool(final['armour']),
    'litShelter': final['litBase'], 'nightSurvived': nights >= 1, 'chest': final['chest'],
}
report = {'start': start, 'final': final, 'deaths': deaths, 'nights': nights,
          'scored': scored, 'passed': sum(scored.values()), 'of': len(scored), 'milestones': milestones}
(out / 'report.json').write_text(json.dumps(report, indent=2))
(out / 'after.json').write_text(json.dumps(end, indent=2))
print(json.dumps({'report': str(out / 'report.json'), **{k: v for k, v in report.items() if k != 'milestones'}}), flush=True)
