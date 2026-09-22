const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('soulstone',Object.freeze({
 command:(name,value)=>ipcRenderer.invoke('soulstone:command',name,value),
 onEvent:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('soulstone:event',listener);return ()=>ipcRenderer.removeListener('soulstone:event',listener)}
}))
