const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('readingApp', Object.freeze({
 annotations:(action,payload)=>ipcRenderer.invoke('reading:annotations',action,payload),
 onAnnotationsChanged:cb=>{const fn=(_e,p)=>cb(p);ipcRenderer.on('reading:annotations-changed',fn);return()=>ipcRenderer.removeListener('reading:annotations-changed',fn);},
  setActiveSession:id=>ipcRenderer.send('reading:active-session',id),
  business:(action,payload)=>ipcRenderer.invoke('reading:business',action,payload),
  openBook: id => ipcRenderer.invoke('reading:open-book', id),
  setNotesScope: scope=>ipcRenderer.invoke('reading:notes-scope',scope),
  searchNotes: query=>ipcRenderer.invoke('reading:notes-search',query),
  openNote: id => ipcRenderer.invoke('reading:open-note', id),
  setImmersive: value => ipcRenderer.invoke('reading:immersive', value),
  setSidebar: value => ipcRenderer.invoke('reading:sidebar', value),
  selectView: view => ipcRenderer.invoke('reading:select', view),
  selectReadingTab: tab => ipcRenderer.invoke('reading:tab', tab),
  selectRightTool: tool => ipcRenderer.invoke('reading:right-tool', tool),
  setChatWidth: request => ipcRenderer.invoke('reading:chat-width', request),
  setChat: options => ipcRenderer.invoke('reading:chat-layout', options),
  sessions: (action, payload) => ipcRenderer.invoke('reading:sessions', action, payload),
  getState: () => ipcRenderer.invoke('reading:state'),
  restartRuntime: () => ipcRenderer.invoke('reading:restart'),
  showRuntimeStatus: () => ipcRenderer.invoke('reading:show-status'),
  onSource:callback=>{const fn=(_e,id)=>callback(id);ipcRenderer.on('reading:source-selected',fn);return()=>ipcRenderer.removeListener('reading:source-selected',fn);},
  onState: callback => {
    if (typeof callback !== 'function') throw new TypeError('Callback required');
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('reading:state', listener);
    return () => ipcRenderer.removeListener('reading:state', listener);
  },
  onSessionEvent: callback => {
    if (typeof callback !== 'function') throw new TypeError('Callback required');
    const listener = (_event, event) => callback(event);
    ipcRenderer.on('reading:session-event', listener);
    return () => ipcRenderer.removeListener('reading:session-event', listener);
  },
}));

contextBridge.exposeInMainWorld('readingAppearance',Object.freeze({get:()=>ipcRenderer.invoke('reading:appearance-get'),modal:value=>ipcRenderer.invoke('reading:appearance-modal',value),set:value=>ipcRenderer.invoke('reading:appearance-set',value),open:()=>ipcRenderer.send('reading:appearance-open'),onChange:cb=>{ipcRenderer.on('reading:appearance',(_e,p)=>cb(p));}}));

ipcRenderer.on('reading:appearance-open',()=>window.dispatchEvent(new Event('ai-reading:open-appearance')));
