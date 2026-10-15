// The dimension the bot is in, and the one a saved thing was made in
// (workstreams/minecraft/nether-plan.md, step 2). Saved state from before
// 7 October carries none, and all of it was made in the Overworld, so a
// missing dimension means overworld and nothing old needs migrating.
export const dimensionOf=bot=>String(bot?.game?.dimension||'').replace(/^minecraft:/,'')||null
export const projectDimension=p=>p?.dimension||'overworld'
// An unknown current dimension is not evidence of another one.
export const sameDimension=(bot,p)=>{const here=dimensionOf(bot);return !here||here===projectDimension(p)}
// The Nether has a bedrock ceiling and no sky; mineflayer still reports the
// shared world clock there, so clock rules must not read it as night.
export const inNether=bot=>dimensionOf(bot)==='the_nether'
// The End has sky but no sun: the clock runs and nothing there follows it.
export const inEnd=bot=>dimensionOf(bot)==='the_end'
