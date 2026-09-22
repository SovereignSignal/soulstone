#!/usr/bin/env python3
"""ASCII table of the last 14 rung-scoreboard.csv runs. No matplotlib."""
import csv
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CSV_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'results' / 'rung-scoreboard.csv'
RUNGS = ('wood_tools', 'stone_tools', 'shelter', 'iron', 'iron_pickaxe', 'diamond')
COLS = [f't_{r}_s' for r in RUNGS]


def mins(cell):
    if cell is None or cell == '':
        return '-'
    try:
        return str(int(round(float(cell) / 60)))
    except ValueError:
        return '-'


def main():
    if not CSV_PATH.exists():
        print(f'No scoreboard at {CSV_PATH}')
        return 1
    with CSV_PATH.open(newline='') as fh:
        rows = list(csv.DictReader(fh))
    rows = rows[-14:]
    headers = ['start', 'max', *RUNGS, 'deaths', 'rounds']
    table = [headers]
    for row in rows:
        start = (row.get('start_iso') or '')[:16]
        table.append([
            start,
            row.get('max_rung') or '-',
            *[mins(row.get(c)) for c in COLS],
            row.get('deaths') or '0',
            row.get('rounds') or '0',
        ])
    widths = [max(len(str(r[i])) for r in table) for i in range(len(headers))]
    for i, row in enumerate(table):
        line = ' | '.join(str(row[j]).ljust(widths[j]) for j in range(len(headers)))
        print(line)
        if i == 0:
            print('-+-'.join('-' * w for w in widths))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
