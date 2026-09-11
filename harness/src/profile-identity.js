// A world keeps its state when its address, LAN port or client version changes.
// Existing portable profiles retain their original connection key unchanged.
export function worldIdentity(id, identity) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || '')) throw new Error('Invalid world ID')
  const key=JSON.stringify(['world',id])
  if (identity===undefined || identity===null || identity===key) return key
  if(typeof identity!=='string'||identity.length>1024)throw new Error('Invalid world identity')
  const legacy=JSON.parse(identity)
  if(!Array.isArray(legacy)||![4,5].includes(legacy.length)||![0,2,3].every(i=>typeof legacy[i]==='string'&&legacy[i].length>0)||!Number.isInteger(legacy[1])||legacy[1]<1||legacy[1]>65535||(legacy.length===5&&legacy[4]!=='microsoft'))throw new Error('Invalid legacy world identity')
  return identity
}
