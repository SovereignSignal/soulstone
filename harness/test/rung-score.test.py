"""Unit tests for rung-score reducers (no network, no live agent)."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'rung_score', Path(__file__).with_name('rung-score.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def snap(**extra):
    base = {
        'connected': True,
        'dead': False,
        'health': 20,
        'position': {'x': 0.5, 'y': 64, 'z': 0.5},
        'inventory': {},
        'tools': [],
        'survival': {'food': 20, 'timeOfDay': 1000, 'dimension': 'overworld'},
        'requestProgress': None,
        'litShelterVerified': False,
        'lastDeath': None,
    }
    base.update(extra)
    return base


class PredicateTests(unittest.TestCase):
    def test_each_rung_predicate(self):
        cases = [
            ('wood_tools', snap(inventory={'wooden_axe': 1})),
            ('wood_tools', snap(inventory={'wooden_pickaxe': 2})),
            ('stone_tools', snap(inventory={'stone_pickaxe': 1})),
            ('shelter', snap(litShelterVerified=True)),
            ('shelter', snap(requestProgress={
                'verification': {'checks': [{'kind': 'shelter', 'passed': True}]},
            })),
            ('iron', snap(inventory={'iron_ingot': 1})),
            ('iron', snap(inventory={'iron_pickaxe': 1})),
            ('iron_pickaxe', snap(inventory={'iron_pickaxe': 1})),
            ('diamond', snap(inventory={'diamond': 1})),
            ('diamond', snap(inventory={'diamond_pickaxe': 1})),
            ('obsidian', snap(inventory={'obsidian': 10})),
            ('portal_lit', snap(requestProgress={
                'verification': {'checks': [{
                    'kind': 'block_at', 'item': 'nether_portal', 'passed': True,
                }]},
            })),
            ('portal_lit', snap(survival={'dimension': 'the_nether'})),
            ('nether', snap(survival={'dimension': 'the_nether'})),
            ('blaze_rods', snap(inventory={'blaze_rod': 1})),
            ('ender_pearls', snap(inventory={'ender_pearl': 1})),
            ('eyes', snap(inventory={'ender_eye': 1})),
            ('end', snap(survival={'dimension': 'the_end'})),
            ('dragon', snap(requestProgress={
                'verification': {'checks': [{
                    'kind': 'entity_dead', 'item': 'ender_dragon', 'passed': True,
                }]},
            })),
        ]
        for rung_id, state in cases:
            self.assertTrue(m.predicate(rung_id, state), rung_id)

    def test_inventory_rungs_ignore_worn_armour(self):
        # Armour lives in slots 5–8 and is absent from inventory; iron helmet
        # must not satisfy the iron or iron_pickaxe rungs.
        state = snap(inventory={})
        state['wornArmour'] = ['iron_helmet', 'iron_chestplate']
        state['tools'] = [{'name': 'iron_pickaxe'}]  # tools list is not inventory
        self.assertFalse(m.predicate('iron', state))
        self.assertFalse(m.predicate('iron_pickaxe', state))
        self.assertFalse(m.predicate('wood_tools', state))

    def test_dimension_rungs_fire(self):
        self.assertTrue(m.predicate('nether', snap(survival={'dimension': 'the_nether'})))
        self.assertTrue(m.predicate('end', snap(survival={'dimension': 'the_end'})))
        self.assertFalse(m.predicate('nether', snap(survival={'dimension': 'overworld'})))

    def test_obsidian_threshold(self):
        self.assertFalse(m.predicate('obsidian', snap(inventory={'obsidian': 9})))
        self.assertTrue(m.predicate('obsidian', snap(inventory={'obsidian': 10})))

    def test_dragon_does_not_fire_without_check(self):
        self.assertFalse(m.predicate('dragon', snap()))


class MonotoneTests(unittest.TestCase):
    def test_reached_stays_reached_and_lost_at(self):
        t = m.RungTracker(0, '2026-01-01T00:00:00+00:00')
        t.observe(snap(inventory={'stone_pickaxe': 1}), 10, 't1')
        row = t.rungs['stone_tools']
        self.assertTrue(row['reached'])
        self.assertEqual(row['elapsed_s'], 10)
        t.observe(snap(inventory={}), 20, 't2')
        self.assertTrue(row['reached'])
        self.assertEqual(row['lost_at'], 't2')
        t.observe(snap(inventory={'stone_pickaxe': 1}), 30, 't3')
        self.assertTrue(row['reached'])
        self.assertIsNone(row['lost_at'])
        self.assertEqual(t.max_rung(), 'stone_tools')


class DeathTests(unittest.TestCase):
    def test_three_signals_no_double_count(self):
        d = m.DeathCounter()
        # Single death reported three ways across samples.
        d.observe(snap(dead=False, lastDeath=None, requestProgress={'autoRespawns': 0}))
        d.observe(snap(dead=True, lastDeath={'at': 'A'}, requestProgress={'autoRespawns': 0}))
        self.assertEqual(d.deaths, 1)
        d.observe(snap(dead=True, lastDeath={'at': 'A'}, requestProgress={'autoRespawns': 1}))
        self.assertEqual(d.deaths, 1)
        # A second distinct death via lastDeath alone.
        d.observe(snap(dead=False, lastDeath={'at': 'B'}, requestProgress={'autoRespawns': 1}))
        self.assertEqual(d.deaths, 2)

    def test_autorespawn_alone(self):
        d = m.DeathCounter()
        d.observe(snap(requestProgress={'autoRespawns': 0}))
        d.observe(snap(requestProgress={'autoRespawns': 2}))
        self.assertEqual(d.deaths, 2)

    def test_same_sample_all_three(self):
        d = m.DeathCounter()
        d.observe(snap(dead=False, lastDeath=None, requestProgress={'autoRespawns': 0}))
        d.observe(snap(dead=True, lastDeath={'at': 'X'}, requestProgress={'autoRespawns': 1}))
        self.assertEqual(d.deaths, 1)


class CsvTests(unittest.TestCase):
    def test_csv_column_count(self):
        tracker = m.RungTracker(0, 'start')
        tracker.observe(snap(inventory={'wooden_pickaxe': 1, 'stone_pickaxe': 1}), 5, 't')
        report = m.build_report(
            start_iso='2026-09-22T00:00:00+00:00',
            end_iso='2026-09-22T01:00:00+00:00',
            request_text='craft stone tools',
            request_id='req-1',
            hours=2,
            terminal='time_limit',
            tracker=tracker,
            deaths=1,
            rounds=4,
            cells_visited=12,
            final_state=snap(),
        )
        row = m.csv_row(report)
        self.assertEqual(len(row), len(m.CSV_HEADER))
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'rung-scoreboard.csv'
            m.append_scoreboard(path, report)
            text = path.read_text().strip().splitlines()
            self.assertEqual(len(text), 2)
            self.assertEqual(len(text[0].split(',')), len(m.CSV_HEADER))
            self.assertEqual(len(text[1].split(',')), len(m.CSV_HEADER))


class TerminalTests(unittest.TestCase):
    def test_terminal_statuses(self):
        self.assertTrue(m.is_terminal({'status': 'verified'}))
        self.assertTrue(m.is_terminal({'status': 'cancelled'}))
        self.assertTrue(m.is_terminal({'status': 'blocked', 'reviewRequired': 'look'}))
        self.assertFalse(m.is_terminal({'status': 'blocked'}))
        self.assertFalse(m.is_terminal({'status': 'running'}))


if __name__ == '__main__':
    unittest.main()
