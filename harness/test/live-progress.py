"""Bounded natural progression trial. No grants, respawns, or automatic retries."""
import argparse
import json
import time
import urllib.request
from pathlib import Path

TOOLS = ('_pickaxe', '_axe', '_shovel', '_sword', '_hoe')


def snapshot(state):
    inv = state.get('inventory') or {}
    food = (state.get('survival') or {}).get('carriedFood') or []
    return {
        'health': state.get('health'),
        'hunger': (state.get('survival') or {}).get('food'),
        'tools': sorted(k for k, n in inv.items() if n > 0 and k.endswith(TOOLS)),
        'food': {f['name']: f['count'] for f in food if f.get('count', 0) > 0},
        'litBase': state.get('litShelterVerified') is True,
        'inventory': inv,
    }


class Progress:
    """Only new resource highs and distinct completed work count as progress.

    Motion, repeated failure, and returning to the same inventory do not reset
    the clock. Deliberately conservative: long travel or planning can stall.
    """
    def __init__(self, state, now):
        self.high = dict(state.get('inventory') or {})
        self.receipts = set()
        self.lit = snapshot(state)['litBase']
        self.last = now
        self.observe(state, now)

    def observe(self, state, now):
        changed = False
        for name, count in (state.get('inventory') or {}).items():
            if count > self.high.get(name, 0):
                changed = True
                self.high[name] = count
        for entry in (state.get('requestProgress') or {}).get('completed', []):
            step = entry.get('step') or {}
            if step.get('action') in ('inspect', 'remember', 'come', 'follow', 'return', 'travel'):
                continue
            key = json.dumps(step, sort_keys=True)
            if key not in self.receipts:
                self.receipts.add(key)
                changed = True
        if snapshot(state)['litBase'] and not self.lit:
            changed = self.lit = True
        if changed:
            self.last = now
        return changed


def run(call, out, message, minutes=20, stall_seconds=120, interval=5, clock=time.monotonic, sleep=time.sleep):
    out.mkdir(parents=True, exist_ok=True)
    before = call('/state')
    if not before.get('connected') or before.get('dead'):
        raise RuntimeError('The agent must be alive and connected before a trial')
    (out / 'before.json').write_text(json.dumps(before, indent=2))
    started = clock()
    tracker = Progress(before, started)
    last = before
    reason = 'error'
    error = None
    cleanup = {}
    try:
        call('/message', {'text': message})
        with (out / 'samples.jsonl').open('w') as samples:
            while True:
                last = call('/state')
                elapsed = clock() - started
                tracker.observe(last, clock())
                record = {'elapsed': round(elapsed, 1), 'phase': last.get('phase'), 'snapshot': snapshot(last),
                          'position': last.get('position'), 'task': last.get('task'), 'safety': last.get('safety'),
                          'requestProgress': last.get('requestProgress'), 'threatJudge': last.get('threatJudge')}
                samples.write(json.dumps(record) + '\n'); samples.flush()
                now = snapshot(last)
                if last.get('dead') or last.get('health') == 0:
                    reason = 'death'; break
                if not last.get('connected'):
                    reason = 'disconnected'; break
                if now['food'] and len(now['tools']) >= 2 and now['litBase']:
                    reason = 'targets_met'; break
                if elapsed >= minutes * 60:
                    reason = 'time_limit'; break
                if clock() - tracker.last >= stall_seconds:
                    reason = 'no_progress'; break
                sleep(min(interval, minutes * 60 - elapsed, stall_seconds - (clock() - tracker.last)))
    except Exception as exc:
        error = str(exc)
    finally:
        # Cancel before disconnecting so restarting the service cannot silently
        # continue an expired trial. Still disconnect if cancellation fails.
        for path in ('/stop', '/shutdown'):
            try:
                call(path, {})
                cleanup[path] = 'ok'
            except Exception as exc:
                cleanup[path] = str(exc)
        (out / 'after.json').write_text(json.dumps(last, indent=2))
        report = {'reason': reason, 'error': error, 'elapsed': round(clock() - started, 1),
                  'message': message, 'start': snapshot(before), 'final': snapshot(last),
                  'mode': before.get('threatJudge'), 'passed': reason == 'targets_met', 'cleanup': cleanup}
        (out / 'report.json').write_text(json.dumps(report, indent=2))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('state_dir', type=Path)
    parser.add_argument('--message', required=True)
    parser.add_argument('--minutes', type=float, default=20)
    parser.add_argument('--stall-seconds', type=float, default=120)
    parser.add_argument('--interval', type=float, default=5)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if min(args.minutes, args.stall_seconds, args.interval) <= 0:
        parser.error('Time bounds must be positive')
    endpoint = json.loads((args.state_dir / 'companion-api.json').read_text())
    out = args.output or Path(__file__).resolve().parents[1] / 'results' / f'progress-{time.strftime("%Y%m%d-%H%M%S")}'

    def call(path, payload=None):
        req = urllib.request.Request(endpoint['url'] + path,
            data=None if payload is None else json.dumps(payload).encode(),
            headers={'Authorization': 'Bearer ' + endpoint['token'], 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=10) as response:
            return json.load(response)

    print(json.dumps({'output': str(out), 'message': args.message, 'minutes': args.minutes, 'stallSeconds': args.stall_seconds}), flush=True)
    report = run(call, out, args.message, args.minutes, args.stall_seconds, args.interval)
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
