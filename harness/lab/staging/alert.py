# Watches one staged run: prints the bot's notable messages and exits on a death, a
# finished request, or the run's end. alert.py <run.out> <since-iso>
# A "could not finish" that only means the night hold (the bot waits in its base for
# daylight and carries the request on by itself) is noted, not treated as the end.
import json,sys,time,urllib.request,os
out,since=sys.argv[1],sys.argv[2]
API=os.path.join(os.environ.get("SOULSTONE_RUN",os.path.expanduser("~/soulstone/run")),"state","companion-api.json")
KEYS=("I died","could not finish","Still no clear area","blaze rod","Nether","portal","taking cover","Retracing","fighting it too")
seen=set()
while True:
  try:
    c=json.load(open(API))
    d=json.load(urllib.request.urlopen(urllib.request.Request(c["url"]+"/state",headers={"Authorization":"Bearer "+c["token"]}),timeout=20))
    for m in d.get("messages") or []:
      if m["at"]>since and m["at"] not in seen and any(k in m["text"] for k in KEYS):
        seen.add(m["at"]);print("NOTE",m["at"][11:19],m["text"][:170],flush=True)
    if d.get("dead"):print("DEAD",flush=True);break
    status=(d.get("requestProgress") or {}).get("status")
    if status in ("completed","verified","needs_review","failed"):print("REQUEST",status,flush=True);break
  except Exception:pass
  if os.path.exists(out) and "ended" in open(out).read():print("ENDED",open(out).read().strip().splitlines()[-1][:200],flush=True);break
  time.sleep(20)
