// What the teammate says in game chat. The companion's own log keeps every
// line; the game gets the lines a player can use, in plain words. On
// 3 October "soul come" was answered in chat with "That set of completion
// criteria would pass without doing the work. Restating them."
const INTERNAL=[/completion criteria/i,/^Automatically continuing/i,/^Resume the saved request/i,/goal_check|plan validation/i]
// The safety system's set phrases, in words a seven-year-old can follow.
const PLAIN=[
 [/^A potential hostile is within ten blocks/,'Uh oh, a monster is close! Hang on.'],
 [/^I am choosing shelter:/,null],
 [/^I need shelter now:/,'Too many monsters! I need to hide.'],
 [/^A creeper is [\d.]+ blocks away\. Sprinting clear/,'Creeper! Running away!'],
 [/^A (\w+) is [\d.]+ blocks away and I have no shelter to reach\. Sprinting clear/,'A $1 is chasing me! Running away!'],
 [/^I can defend against this (\w+)/,'Fighting the $1!'],
 [/^The (\w+) died after my attacks/,'Got the $1!'],
 [/^Cornered by a (\w+)/,'I am trapped by a $1! Fighting back!'],
 [/^I reached (?:the lit base|base) and closed the door/,'I made it inside my house. Safe!'],
 [/^I reached .* and closed the door/,'I am inside and safe.'],
 [/^No verified shelter is reachable\. I am digging in/,'Digging a hole to hide in until it is safe!'],
 [/^The ground here cannot be dug\. I am walling myself in/,'Building walls around me to stay safe!'],
 [/^I am (?:dug in|walled in)/,null],
 [/^(?:base|[\w_-]+) is unavailable:/,null],
 [/^Daylight with no hostile nearby\. Opening up/,'It is safe now. Coming out!'],
 [/^Back on the surface/,'I am out! What should I do next?'],
 [/^It is night and I am in the base\./,'It is night, so I am staying inside. I will do it in the morning!'],
 [/^A (\w+) is [\d.]+ blocks from the base\./,'A $1 is right outside, so I am staying in for now.'],
 [/Dusk is (?:here|less than a minute away)/,'It is getting dark, so I will stay inside and do it in the morning.'],
 [/inside its interruption radius; staying in/,'A monster is near the door, so I am staying inside for now.'],
 [/^Food is critically low/,'I am really hungry! Going to eat.'],
 [/^I have food and clear daylight ground\. Eating/,'Snack time!'],
 [/^(?:I could not finish:|Blocked:).*(?:not visible|visible player|cannot see you|not in view|come into view)/i,'I cannot see you! Come closer so I can find you.'],
 [/^I could not finish:/,'I could not finish that one, sorry!'],
 [/^I died\./,'Oh no, I died! I will come back.'],
 [/^Respawning at the world spawn/,null],
 [/^I respawned\./,'I am back!'],
 [/^Stopped\. I will wait for your next instruction/,'OK, I stopped.'],
 [/^Ready for your next instruction/,'What should I do next?'],
 [/^Departure verified\./,null],
 [/^I am staying sheltered\. Resume is required/,'I am staying inside where it is safe.'],
 [/^The planner did not answer in time/,'Sorry, I was thinking too slowly. Trying again!'],
]
export function gameLine(text){
 let t=String(text||'').replace(/\s+/g,' ').trim()
 if(!t||INTERNAL.some(r=>r.test(t)))return null
 if(/^The executable checks passed\./.test(t))return 'Done!'
 for(const [pattern,plain] of PLAIN){const m=pattern.exec(t);if(m)return plain===null?null:plain.replace(/\$(\d)/g,(_,i)=>m[+i]||'')}
 if(/^(?:I could not finish:|Blocked:).*(?:not visible|visible player|cannot see you|not in view|come into view)/i.test(t))return 'I cannot see you! Come closer so I can find you.'
 const blocked=/^Blocked: (.*?)(?:\. I will inspect the result and revise the plan\.?)?$/.exec(t)
 // The reason is for the app; a young player in game chat gets the gist (4 October:
 // "That did not work (Goto leg exceeded its 25 second budget ...)").
 if(blocked)return 'Hmm, that did not work. Trying something else!'
 t=t.replace(/^I will Going to /,'I am going to ').replace(/^I will Digging /,'I am digging ')
 if(t.length>220){const cut=t.slice(0,220),end=Math.max(cut.lastIndexOf('. '),cut.lastIndexOf('! '));t=end>80?cut.slice(0,end+1):cut.replace(/\s+\S*$/,'')+'…'}
 return t
}
// One job at a time. While a game-chat request from one player is being
// worked on, another player's new request gets a reply instead of silently
// cancelling the first; the owner always overrides, and "stop" (a fixed
// command) works for anyone. Requests that are waiting (night, sheltering)
// can be replaced.
export function busyFor(teammate,name,owner){
 const r=teammate?.requestProgress
 if(!r||r.status!=='running'||!['thinking','acting'].includes(teammate.phase))return null
 const who=r.requester
 if(!who||who.toLowerCase()===String(name).toLowerCase()||String(name).toLowerCase()===String(owner||'').toLowerCase())return null
 return `I am busy helping ${who} right now. Wait for me, or say "soul stop" first.`
}
