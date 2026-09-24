import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('ghost_check', Path(__file__).with_name('ghost-check.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ParseTests(unittest.TestCase):
    def test_reads_cells_and_target_from_a_refusal(self):
        reason = ('Goto leg exceeded its 25 second budget without closing ground; 4 blocks short. Pathfinder: 8 plans. '
                  'Body: physics ticks 500; server corrections 480; corrections moved it 0.3 on average, last to -614.5,69,-335.7; '
                  'onGround false, velocity 0,0,0, underfoot grass_block. client solid cells: -615,68,-336 grass_block; -615,70,-335 spruce_leaves.')
        cells, target = m.parse(reason)
        self.assertEqual(cells, {(-615, 68, -336): 'grass_block', (-615, 70, -335): 'spruce_leaves'})
        self.assertEqual(target, (-614.5, 69.0, -335.7))

    def test_a_refusal_without_cells_is_skipped(self):
        self.assertIsNone(m.parse('Goto leg exceeded its 25 second budget without closing ground'))


if __name__ == '__main__':
    unittest.main()
