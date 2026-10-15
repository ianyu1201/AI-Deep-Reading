const { ipcRenderer, contextBridge } = require('electron');
window.addEventListener('ai-reading:note-context', event => {
 const id = event.detail?.id;
 if (typeof id === 'string' && id.length <= 256) ipcRenderer.send('reading:note-context', {id});
});

contextBridge.exposeInMainWorld('readingNotes', Object.freeze({viewSource:payload=>ipcRenderer.invoke('reading:note-source',payload),call: (action, payload = {}) => {
 if (!['list','read','search','save'].includes(action)) return Promise.reject(new Error('Invalid note action'));
 return ipcRenderer.invoke('reading:notes', action, payload);
}}));

contextBridge.exposeInMainWorld('readingAppearance',Object.freeze({get:()=>ipcRenderer.invoke('reading:appearance-get'),modal:value=>ipcRenderer.invoke('reading:appearance-modal',value),set:value=>ipcRenderer.invoke('reading:appearance-set',value),open:()=>ipcRenderer.send('reading:appearance-open'),onChange:cb=>{ipcRenderer.on('reading:appearance',(_e,p)=>cb(p));}}));

window.addEventListener('ai-reading:workspace-navigation',e=>{if(['reading','guide','original','annotations'].includes(e.detail))ipcRenderer.send('reading:child-navigation',e.detail);});
