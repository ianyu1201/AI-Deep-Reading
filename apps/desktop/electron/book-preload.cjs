const { ipcRenderer } = require('electron');
// Narrow library and source capabilities only; no paths or general file API.
// Main validates top-frame sender, registration, payload and source authority.
window.addEventListener('ai-reading:book-opening', event => {
 const value=event.detail;if(value&&typeof value.id==='string'&&typeof value.intent==='string')ipcRenderer.send('reading:book-opening',{id:value.id.slice(0,256),intent:value.intent.slice(0,128)});
});
window.addEventListener('ai-reading:book-context', event => {
  const value = event.detail;
  if (!value || typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.author !== 'string' || typeof value.open !== 'boolean') return;
  ipcRenderer.send('reading:book-context', { id: value.id.slice(0, 256), title: value.title.slice(0, 300), author: value.author.slice(0, 300), open: value.open, intent: typeof value.intent==='string'?value.intent.slice(0,128):'' });
});
window.addEventListener('DOMContentLoaded', () => window.dispatchEvent(new Event('ai-reading:context-request')));

window.addEventListener('ai-reading:enter-immersive', () => ipcRenderer.send('reading:reader-mode', true));
window.addEventListener('ai-reading:exit-immersive', () => ipcRenderer.send('reading:reader-mode', false));

window.addEventListener('ai-reading:library-changed', () => ipcRenderer.send('reading:library-changed'));
window.addEventListener('ai-reading:library-request', () => ipcRenderer.send('reading:library-request'));

const {contextBridge}=require('electron');
contextBridge.exposeInMainWorld('readingDesktopBooks',Object.freeze({
 bookmarks:(action,payload)=>ipcRenderer.invoke('reading:bookmarks',action,payload),
 annotations:(action,payload)=>ipcRenderer.invoke('reading:annotations',action,payload),
 onAnnotationsChanged:cb=>{const fn=(_e,p)=>cb(p);ipcRenderer.on('reading:annotations-changed',fn);return()=>ipcRenderer.removeListener('reading:annotations-changed',fn);},
 ready:()=>ipcRenderer.invoke('reading:books-ready'),
 list:()=>ipcRenderer.invoke('reading:books-list'),
 importFile:()=>ipcRenderer.invoke('reading:books-import'),
 appleBooks:(action,payload)=>ipcRenderer.invoke('reading:apple-books',action,payload),
 onAppleProgress:callback=>{if(typeof callback!=='function')throw new TypeError('Callback required');const listener=(_event,progress)=>callback(progress);ipcRenderer.on('reading:apple-progress',listener);return()=>ipcRenderer.removeListener('reading:apple-progress',listener);},
 sourceChapter:payload=>ipcRenderer.invoke('reading:source-chapter',payload),
 discussSelection:payload=>ipcRenderer.invoke('reading:selection',payload),
}));

contextBridge.exposeInMainWorld('readingAppearance',Object.freeze({get:()=>ipcRenderer.invoke('reading:appearance-get'),modal:value=>ipcRenderer.invoke('reading:appearance-modal',value),set:value=>ipcRenderer.invoke('reading:appearance-set',value),open:()=>ipcRenderer.send('reading:appearance-open'),onChange:cb=>{ipcRenderer.on('reading:appearance',(_e,p)=>cb(p));}}));

window.addEventListener('ai-reading:workspace-navigation',e=>{if(['reading','guide','original','annotations'].includes(e.detail))ipcRenderer.send('reading:child-navigation',e.detail);});
