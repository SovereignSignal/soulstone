"""Compare the client's view of a stuck leg's surroundings with the server's.

Runs on the VM beside the agent. Follows agent.log; for each stuck leg whose
refusal lists `client solid cells:` and a correction target, it asks the server
about every cell around that target with `execute if block` (read-only) and
appends the disagreements to results/ghost-check.jsonl. A cell the server holds
solid where the client sees nothing solid is a ghost the bot keeps walking into.
"""
import json
import math
import os
import re
import subprocess
import sys
import time

CELLS = re.compile(r'client solid cells: (.*?)\.(?:\s|$)')
TARGET = re.compile(r'last to (-?[\d.]+),(-?[\d.]+),(-?[\d.]+)')
PASSABLE = ['air', 'cave_air', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'sweet_berry_bush', 'spruce_sapling',
            'oak_sapling', 'dandelion', 'poppy', 'dead_bush', 'bush', 'firefly_bush', 'leaf_litter', 'short_dry_grass',
            'tall_dry_grass', 'snow', 'torch', 'wall_torch', 'water', 'vine', 'moss_carpet']
SOLID = ['spruce_log', 'spruce_leaves', 'oak_log', 'oak_leaves', 'birch_log', 'birch_leaves', 'grass_block', 'dirt',
         'podzol', 'coarse_dirt', 'stone', 'cobblestone', 'granite', 'diorite', 'andesite', 'gravel', 'sand',
         'mossy_cobblestone', 'crafting_table', 'furnace', 'spruce_planks', 'oak_planks', 'dirt_path', 'moss_block']


def parse(reason):
    """Client solid cells {(x,y,z): name} and the last correction target, from one refusal."""
    m, t = CELLS.search(reason or ''), TARGET.search(reason or '')
    if not m or not t:
        return None
    cells = {}
    for part in m.group(1).split('; '):
        coords, _, name = part.partition(' ')
        x, y, z = (int(v) for v in coords.split(','))
        cells[(x, y, z)] = name
    return cells, tuple(float(v) for v in t.groups())


def rcon(cmd):
    return subprocess.run(['docker', 'exec', 'mc-sandbox', 'rcon-cli', cmd], capture_output=True, text=True).stdout


def server_is(x, y, z, name):
    return 'passed' in rcon(f'execute if block {x} {y} {z} minecraft:{name}')


def server_name(x, y, z):
    for name in PASSABLE + SOLID:
        if server_is(x, y, z, name):
            return name
    return 'unlisted'


def compare(cells, target):
    px, py, pz = target
    out = []
    for x in range(math.floor(px - 0.7), math.floor(px + 0.7) + 1):
        for z in range(math.floor(pz - 0.7), math.floor(pz + 0.7) + 1):
            for y in range(math.floor(py) - 1, math.floor(py) + 3):
                client = cells.get((x, y, z))
                if client and server_is(x, y, z, client):
                    continue
                server = server_name(x, y, z)
                if client is None and server in PASSABLE:
                    continue
                out.append({'cell': [x, y, z], 'client': client or 'not solid', 'server': server})
    return out


def follow(log, out_path):
    with open(log) as f:
        f.seek(0, os.SEEK_END)
        while True:
            line = f.readline()
            if not line:
                time.sleep(1)
                continue
            if 'client solid cells' not in line:
                continue
            row = json.loads(line)
            # A task refusal carries it in task.reason; gather's skipped logs in a progress message.
            text = row.get('task', {}).get('reason') if row.get('type') == 'task_finished' else row.get('message')
            parsed = parse(text)
            if not parsed:
                continue
            diff = compare(*parsed)
            kind = row['task'].get('kind') if row.get('type') == 'task_finished' else 'gather-walk'
            with open(out_path, 'a') as o:
                o.write(json.dumps({'at': row['at'], 'kind': kind, 'target': parsed[1], 'disagreements': diff}) + '\n')


if __name__ == '__main__':
    follow(os.path.expanduser(sys.argv[1] if len(sys.argv) > 1 else '~/soulstone/run/agent.log'),
           sys.argv[2] if len(sys.argv) > 2 else 'results/ghost-check.jsonl')
