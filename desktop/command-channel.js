export class CommandChannel {
 constructor(request){this.request=request;this.sequence=0}
 advance(){return ++this.sequence}
 current(sequence){return sequence===this.sequence}
 send(path,payload={},sequence=this.advance()){
  if(!this.current(sequence))return Promise.resolve({superseded:true})
  return this.request(path,{...payload,client:'soulstone-desktop',sequence})
 }
}
