# Exit when the lab bot dies, stalls in shelter, gives up, or the named run ends. alert.py <run-out-file> <since-iso>
import json,sys,time,urllib.request,os
# The bot's API address and token are read from its state, under SOULSTONE_RUN (default ~/soulstone/run).
API=os.path.join(os.environ.get('SOULSTONE_RUN',os.path.expanduser('~/soulstone/run')),'state','companion-api.json')
out,since=sys.argv[1],sys.argv[2]
keys=("Still no clear area","could not finish","I died","was slain","Respawn")
while True:
  try:
    c=json.load(open(API))
    d=json.load(urllib.request.urlopen(urllib.request.Request(c["url"]+"/state",headers={"Authorization":"Bearer "+c["token"]}),timeout=15))
    hit=[m for m in d.get("messages") or [] if m["at"]>since and any(k in m["text"] for k in keys)]
    if d.get("dead") or hit: print("ALERT", d.get("dead"), [h["at"][11:19]+" "+h["text"][:200] for h in hit]); break
  except Exception as e: pass
  if os.path.exists(out) and "ended" in open(out).read(): print("ENDED", open(out).read().splitlines()[-1]); break
  time.sleep(15)
