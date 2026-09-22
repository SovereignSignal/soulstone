"""Tech-tree rung scoreboard: time-to-rung, deaths, and planner rounds per run.

Reads the companion HTTP API only. Never talks to the Minecraft server.
"""
from __future__ import annotations

import argparse
import csv
import json
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Rung ladder (order is the scoreboard order; max_rung is the highest reached)
# ---------------------------------------------------------------------------

def _inv(state):
    return state.get('inventory') or {}


def _count(state, name):
    return int(_inv(state).get(name) or 0)


def _has(state, name):
    return _count(state, name) > 0


def _checks(state):
    rp = state.get('requestProgress') or {}
    ver = rp.get('verification') or {}
    return ver.get('checks') or []


def _dim(state):
    return (state.get('survival') or {}).get('dimension')


def _check_passed(state, kind, item_pred=None):
    for c in _checks(state):
        if c.get('kind') != kind or c.get('passed') is not True:
            continue
        if item_pred is None or item_pred(c.get('item') or ''):
            return True
    return False


RUNG_LADDER = (
    {
        'id': 'wood_tools',
        'label': 'Wood tools',
        'pred': lambda s: _has(s, 'wooden_pickaxe') or _has(s, 'wooden_axe'),
    },
    {
        'id': 'stone_tools',
        'label': 'Stone tools',
        'pred': lambda s: _has(s, 'stone_pickaxe'),
    },
    {
        'id': 'shelter',
        'label': 'Lit shelter',
        'pred': lambda s: (
            s.get('litShelterVerified') is True
            or _check_passed(s, 'shelter')
        ),
    },
    {
        'id': 'iron',
        'label': 'Iron',
        'pred': lambda s: _count(s, 'iron_ingot') >= 1 or _has(s, 'iron_pickaxe'),
    },
    {
        'id': 'iron_pickaxe',
        'label': 'Iron pickaxe',
        'pred': lambda s: _has(s, 'iron_pickaxe'),
    },
    {
        'id': 'diamond',
        'label': 'Diamond',
        'pred': lambda s: _count(s, 'diamond') >= 1 or _has(s, 'diamond_pickaxe'),
    },
    {
        'id': 'obsidian',
        'label': 'Obsidian (≥10)',
        'pred': lambda s: _count(s, 'obsidian') >= 10,
    },
    {
        'id': 'portal_lit',
        'label': 'Portal lit',
        'pred': lambda s: (
            _check_passed(s, 'block_at', lambda item: item.startswith('nether_portal'))
            or _dim(s) == 'the_nether'
        ),
    },
    {
        'id': 'nether',
        'label': 'Nether',
        'pred': lambda s: _dim(s) == 'the_nether',
    },
    {
        'id': 'blaze_rods',
        'label': 'Blaze rods',
        'pred': lambda s: _count(s, 'blaze_rod') >= 1,
    },
    {
        'id': 'ender_pearls',
        'label': 'Ender pearls',
        'pred': lambda s: _count(s, 'ender_pearl') >= 1,
    },
    {
        'id': 'eyes',
        'label': 'Eyes of ender',
        'pred': lambda s: _count(s, 'ender_eye') >= 1,
    },
    {
        'id': 'end',
        'label': 'The End',
        'pred': lambda s: _dim(s) == 'the_end',
    },
    {
        'id': 'dragon',
        'label': 'Ender Dragon',
        # entity_dead is not a live criterion kind yet; keep the ladder complete.
        'pred': lambda s: _check_passed(s, 'entity_dead', lambda item: item == 'ender_dragon'),
    },
)

RUNG_IDS = tuple(r['id'] for r in RUNG_LADDER)

# Morning scoreboard CSV (subset of rung times — early tree + deaths/rounds)
CSV_HEADER = (
    'start_iso', 'request', 'hours', 'max_rung',
    't_wood_tools_s', 't_stone_tools_s', 't_shelter_s', 't_iron_s',
    't_iron_pickaxe_s', 't_diamond_s', 'deaths', 'rounds', 'terminal_reason',
)
CSV_TIME_RUNGS = (
    'wood_tools', 'stone_tools', 'shelter', 'iron', 'iron_pickaxe', 'diamond',
)


def iso_now(clock_wall=None):
    if clock_wall is None:
        return datetime.now(timezone.utc).isoformat()
    return datetime.fromtimestamp(clock_wall, tz=timezone.utc).isoformat()


def predicate(rung_id, state):
    for rung in RUNG_LADDER:
        if rung['id'] == rung_id:
            return bool(rung['pred'](state))
    raise KeyError(rung_id)


# ---------------------------------------------------------------------------
# Reducers (pure / importable; no network)
# ---------------------------------------------------------------------------

class RungTracker:
    """Monotone rung reach: once reached, stays reached; lost_at is informational."""

    def __init__(self, started_mono, started_iso):
        self.started_mono = started_mono
        self.started_iso = started_iso
        self.rungs = {
            r['id']: {
                'id': r['id'],
                'label': r['label'],
                'reached': False,
                'at': None,
                'elapsed_s': None,
                'lost_at': None,
            }
            for r in RUNG_LADDER
        }

    def observe(self, state, now_mono, now_iso=None):
        stamp = now_iso or iso_now()
        for rung in RUNG_LADDER:
            rid = rung['id']
            row = self.rungs[rid]
            ok = bool(rung['pred'](state))
            if ok and not row['reached']:
                row['reached'] = True
                row['at'] = stamp
                row['elapsed_s'] = round(now_mono - self.started_mono, 1)
                row['lost_at'] = None
            elif row['reached'] and not ok and row['lost_at'] is None:
                row['lost_at'] = stamp
            elif row['reached'] and ok:
                row['lost_at'] = None  # recovered after a temporary loss record

    def max_rung(self):
        highest = None
        for rid in RUNG_IDS:
            if self.rungs[rid]['reached']:
                highest = rid
        return highest

    def table(self):
        return [dict(self.rungs[rid]) for rid in RUNG_IDS]


class DeathCounter:
    """Merge autoRespawns, dead false→true, and lastDeath changes without double-counting."""

    def __init__(self):
        self.deaths = 0
        self._dead = False
        self._last_key = None
        self._auto = 0
        self._unmatched = 0  # client-side deaths not yet absorbed by autoRespawns

    @staticmethod
    def _key(last_death):
        if last_death is None:
            return None
        return json.dumps(last_death, sort_keys=True, default=str)

    def observe(self, state):
        rp = state.get('requestProgress') or {}
        auto = int(rp.get('autoRespawns') or 0)
        dead = bool(state.get('dead'))
        last_key = self._key(state.get('lastDeath'))

        auto_inc = max(0, auto - self._auto)
        dead_edge = dead and not self._dead
        last_edge = last_key is not None and last_key != self._last_key
        client_death = dead_edge or last_edge

        if auto_inc:
            matched = min(auto_inc, self._unmatched)
            self._unmatched -= matched
            remaining = auto_inc - matched
            if client_death and remaining > 0:
                # Same sample: autoRespawns already covers this death.
                self.deaths += remaining
                client_death = False
            else:
                self.deaths += remaining

        if client_death:
            self.deaths += 1
            self._unmatched += 1

        self._auto = auto
        self._dead = dead
        if last_key is not None:
            self._last_key = last_key
        return self.deaths


def cells_from_position(state, cells):
    pos = state.get('position')
    if not pos:
        return len(cells)
    try:
        cell = (int(pos['x'] // 1), int(pos['z'] // 1))
    except (TypeError, KeyError, ValueError):
        return len(cells)
    cells.add(cell)
    return len(cells)


def is_terminal(request_progress):
    """True when the request will not continue without a new human action."""
    if not request_progress:
        return False
    status = request_progress.get('status')
    if status in ('verified', 'cancelled'):
        return True
    if status in ('blocked', 'interrupted', 'paused') and request_progress.get('reviewRequired'):
        return True
    return False


def terminal_reason(request_progress, fallback='time_limit'):
    if not request_progress:
        return fallback
    status = request_progress.get('status')
    if status == 'verified':
        return 'verified'
    if status == 'cancelled':
        return 'cancelled'
    if status in ('blocked', 'interrupted', 'paused') and request_progress.get('reviewRequired'):
        return f'{status}_review'
    return fallback


def csv_row(report):
    """One scoreboard line matching CSV_HEADER column count."""
    rungs = {r['id']: r for r in report['rungs']}
    times = []
    for rid in CSV_TIME_RUNGS:
        row = rungs.get(rid) or {}
        elapsed = row.get('elapsed_s') if row.get('reached') else None
        times.append('' if elapsed is None else str(elapsed))
    return [
        report.get('start') or '',
        report.get('request') or '',
        str(report.get('hours') if report.get('hours') is not None else ''),
        report.get('max_rung') or '',
        *times,
        str(report.get('deaths', 0)),
        str(report.get('rounds', 0)),
        report.get('terminal_reason') or '',
    ]


def append_scoreboard(csv_path, report):
    csv_path = Path(csv_path)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    write_header = not csv_path.exists() or csv_path.stat().st_size == 0
    row = csv_row(report)
    if len(row) != len(CSV_HEADER):
        raise ValueError(f'CSV row has {len(row)} columns, header has {len(CSV_HEADER)}')
    with csv_path.open('a', newline='') as fh:
        writer = csv.writer(fh)
        if write_header:
            writer.writerow(CSV_HEADER)
        writer.writerow(row)
    return row


def render_report_md(report):
    lines = [
        f"# Rung score — {report.get('start', '')}",
        '',
        f"- Request: `{report.get('request') or '(observe)'}`",
        f"- Request id: `{report.get('request_id') or ''}`",
        f"- Hours: {report.get('hours')}",
        f"- Terminal: `{report.get('terminal_reason')}`",
        f"- Deaths: {report.get('deaths')} · Rounds: {report.get('rounds')} · "
        f"Cells: {report.get('cells_visited')} · Max rung: `{report.get('max_rung') or 'none'}`",
        '',
        '| Rung | Reached | Elapsed (s) | Lost at |',
        '|---|---|---|---|',
    ]
    for r in report.get('rungs') or []:
        reached = 'yes' if r.get('reached') else '—'
        elapsed = r.get('elapsed_s') if r.get('reached') else '—'
        lost = r.get('lost_at') or '—'
        lines.append(f"| {r['id']} | {reached} | {elapsed} | {lost} |")
    lines.append('')
    return '\n'.join(lines)


def build_report(*, start_iso, end_iso, request_text, request_id, hours, terminal,
                 tracker, deaths, rounds, cells_visited, final_state):
    return {
        'start': start_iso,
        'end': end_iso,
        'request': request_text,
        'request_id': request_id,
        'hours': hours,
        'terminal_reason': terminal,
        'rungs': tracker.table(),
        'deaths': deaths,
        'rounds': rounds,
        'max_rung': tracker.max_rung(),
        'cells_visited': cells_visited,
        'final': final_state,
    }


# ---------------------------------------------------------------------------
# Network loop (separate from reducers)
# ---------------------------------------------------------------------------

class CompanionApi:
    """Companion HTTP client; reloads companion-api.json after auth/connection failures."""

    def __init__(self, state_dir, timeout=10):
        self.state_dir = Path(state_dir)
        self.timeout = timeout
        self._endpoint = None
        self.reload()

    def reload(self):
        path = self.state_dir / 'companion-api.json'
        self._endpoint = json.loads(path.read_text())
        return self._endpoint

    def call(self, path, payload=None, retries=4):
        last_err = None
        for attempt in range(retries):
            try:
                url = self._endpoint['url'] + path
                data = None if payload is None else json.dumps(payload).encode()
                req = urllib.request.Request(
                    url,
                    data=data,
                    headers={
                        'Authorization': 'Bearer ' + self._endpoint['token'],
                        'Content-Type': 'application/json',
                    },
                    method='GET' if payload is None else 'POST',
                )
                with urllib.request.urlopen(req, timeout=self.timeout) as response:
                    return json.load(response)
            except urllib.error.HTTPError as exc:
                last_err = exc
                if exc.code in (401, 403):
                    try:
                        self.reload()
                    except OSError:
                        pass
                time.sleep(min(2 ** attempt, 8))
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, json.JSONDecodeError) as exc:
                last_err = exc
                # Agent restart often refreshes the token file.
                try:
                    self.reload()
                except OSError:
                    pass
                time.sleep(min(2 ** attempt, 8))
        raise RuntimeError(f'Companion API unreachable for {path}: {last_err}')


def run_scorer(get_state, out_dir, *, request_text=None, post_message=None,
               hours=2.0, poll=5.0, clock=time.monotonic, wall=time.time, sleep=time.sleep):
    """Poll get_state until hours elapse, request ends, or interrupt.

    get_state() -> snapshot dict
    post_message(text) -> response dict (optional; used when request_text set)
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    started_mono = clock()
    start_iso = iso_now(wall())
    deadline = started_mono + hours * 3600
    tracker = RungTracker(started_mono, start_iso)
    deaths = DeathCounter()
    cells = set()
    request_id = None
    last = {}
    reason = 'time_limit'
    rounds = 0

    if request_text and post_message:
        post_message(request_text)
        # /message returns {ok:true}; id appears on subsequent /state.
    try:
        while True:
            try:
                last = get_state()
            except Exception:
                sleep(poll)
                if clock() >= deadline:
                    reason = 'time_limit'
                    break
                continue

            now = clock()
            tracker.observe(last, now, iso_now(wall()))
            deaths.observe(last)
            cells_from_position(last, cells)
            rp = last.get('requestProgress') or {}
            if rp.get('id'):
                request_id = rp.get('id')
            rounds = int(rp.get('rounds') or 0)

            if is_terminal(rp):
                reason = terminal_reason(rp)
                break
            if now >= deadline:
                reason = 'time_limit'
                break
            sleep(min(poll, max(0.1, deadline - clock())))
    except KeyboardInterrupt:
        reason = 'interrupted'

    end_iso = iso_now(wall())
    report = build_report(
        start_iso=start_iso,
        end_iso=end_iso,
        request_text=request_text,
        request_id=request_id,
        hours=hours,
        terminal=reason,
        tracker=tracker,
        deaths=deaths.deaths,
        rounds=rounds,
        cells_visited=len(cells),
        final_state=last,
    )
    (out_dir / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    (out_dir / 'report.md').write_text(render_report_md(report))
    scoreboard = Path(__file__).resolve().parents[1] / 'results' / 'rung-scoreboard.csv'
    append_scoreboard(scoreboard, report)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--state-dir', type=Path, required=True,
                        help='Directory containing companion-api.json')
    parser.add_argument('--request', default=None,
                        help='If set, POST this text via /message like the native client')
    parser.add_argument('--hours', type=float, default=2.0)
    parser.add_argument('--poll', type=float, default=5.0)
    parser.add_argument('--out', type=Path, default=None)
    args = parser.parse_args(argv)
    if args.hours <= 0 or args.poll <= 0:
        parser.error('--hours and --poll must be positive')

    out = args.out or (
        Path(__file__).resolve().parents[1] / 'results' /
        f'rung-{time.strftime("%Y%m%d-%H%M%S")}'
    )
    api = CompanionApi(args.state_dir)

    def get_state():
        return api.call('/state')

    def post_message(text):
        # Native client / live-progress.py: POST {text: ...}; response is {ok:true}.
        return api.call('/message', {'text': text})

    print(json.dumps({
        'output': str(out),
        'request': args.request,
        'hours': args.hours,
        'poll': args.poll,
    }), flush=True)
    report = run_scorer(
        get_state, out,
        request_text=args.request,
        post_message=post_message if args.request else None,
        hours=args.hours,
        poll=args.poll,
    )
    print(json.dumps({
        'max_rung': report['max_rung'],
        'deaths': report['deaths'],
        'rounds': report['rounds'],
        'terminal_reason': report['terminal_reason'],
        'output': str(out),
    }), flush=True)
    return report


if __name__ == '__main__':
    main()
