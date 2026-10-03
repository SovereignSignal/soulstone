// What the teammate says in game chat. The companion's own log keeps every
// line; the game gets the lines a player can use, in plain words. On
// 3 October "soul come" was answered in chat with "That set of completion
// criteria would pass without doing the work. Restating them."
const INTERNAL=[/completion criteria/i,/^Automatically continuing/i,/^Resume the saved request/i,/goal_check|plan validation/i]
export function gameLine(text){
 let t=String(text||'').replace(/\s+/g,' ').trim()
 if(!t||INTERNAL.some(r=>r.test(t)))return null
 if(/^The executable checks passed\./.test(t))return 'Done!'
 const blocked=/^Blocked: (.*?)(?:\. I will inspect the result and revise the plan\.?)?$/.exec(t)
 if(blocked)t=`That did not work (${blocked[1].replace(/\.$/,'').slice(0,120)}). Trying something else.`
 t=t.replace(/^I will Going to /,'I am going to ').replace(/^I will Digging /,'I am digging ')
 if(t.length>220){const cut=t.slice(0,220),end=Math.max(cut.lastIndexOf('. '),cut.lastIndexOf('! '));t=end>80?cut.slice(0,end+1):cut.replace(/\s+\S*$/,'')+'…'}
 return t
}
