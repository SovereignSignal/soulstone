import importlib.util
import tempfile
import unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('progress', Path(__file__).with_name('live-progress.py'))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class TrialTests(unittest.TestCase):
    def trial(self, states, **kwargs):
        ticks = [0]
        calls = []
        def api(path, payload=None):
            calls.append(path)
            if path == '/state':
                return states.pop(0) if len(states) > 1 else states[0]
            return {'ok': True}
        with tempfile.TemporaryDirectory() as tmp:
            result = m.run(api, Path(tmp), 'test', clock=lambda: ticks[0],
                           sleep=lambda n: ticks.__setitem__(0, ticks[0]+n), interval=1, **kwargs)
        self.assertEqual(calls[-2:], ['/stop', '/shutdown'])
        self.assertNotIn('/respawn', calls)
        return result
    def state(self, **extra):
        return dict(connected=True, health=20, inventory={}, **extra)
    def test_death_stops_once(self):
        self.assertEqual(self.trial([self.state(), self.state(dead=True)])['reason'], 'death')
    def test_stall_and_deadline(self):
        self.assertEqual(self.trial([self.state()], stall_seconds=2)['reason'], 'no_progress')
        self.assertEqual(self.trial([self.state()], minutes=.05)['reason'], 'time_limit')
    def test_target_retention(self):
        state=self.state(litShelterVerified=True,survival={'carriedFood':[{'name':'apple','count':1}]},projects={'base':{'built':True,'stations':{'torch':{'confirmed':True}}}})
        state['inventory']={'wooden_pickaxe':1,'wooden_axe':1,'apple':1}
        self.assertTrue(self.trial([self.state(),state])['passed'])
        state['litShelterVerified']=False
        self.assertFalse(self.trial([self.state(),state],stall_seconds=2)['passed'])
    def test_inventory_oscillation_is_not_progress(self):
        p=m.Progress(self.state(),0)
        state=self.state();state['inventory']={'dirt':1}
        self.assertTrue(p.observe(state,1));self.assertFalse(p.observe(self.state(),2))
        self.assertFalse(p.observe(state,3));self.assertEqual(p.last,1)
    def test_poll_error_still_stops_and_disconnects(self):
        calls=[]
        def api(path,payload=None):
            calls.append(path)
            if path=='/state' and calls.count(path)>1: raise OSError('lost API')
            return self.state()
        with tempfile.TemporaryDirectory() as tmp:
            r=m.run(api,Path(tmp),'test')
        self.assertEqual(r['reason'],'error');self.assertEqual(calls[-2:],['/stop','/shutdown'])

if __name__=='__main__':unittest.main()
