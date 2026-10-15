"""watch.py's dimension stop, apart from the watch so a test can import it without starting a run."""
def dimension_stop(survival,allow_nether=False,allow_end=False):
 """The stop reason for the bot's dimension and portal state, or None to carry on.
 Without a flag the run stays in the Overworld and out of every portal."""
 d=str(survival.get('dimension') or 'overworld').replace('minecraft:','')
 allowed={'overworld'}|({'the_nether'} if allow_nether else set())|({'the_end'} if allow_end else set())
 if d in allowed and (len(allowed)>1 or not survival.get('inPortal')):return None
 return 'end_stop' if d=='the_end' and allow_nether else 'dimension_or_portal_stop'
