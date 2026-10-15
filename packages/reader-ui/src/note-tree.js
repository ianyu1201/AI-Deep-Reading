// Folder strings retain the existing storage contract. This only projects their hierarchy.
export function makeNoteTree(notes){
 const root={folders:[],notes:[]};
 for(const note of notes){
  let node=root,path='';
  for(const name of (note.folder??'').split('/').filter(Boolean)){
   path=path?path+'/'+name:name;
   let folder=node.folders.find(item=>item.path===path);
   if(!folder){folder={name,path,folders:[],notes:[]};node.folders.push(folder)}
   node=folder;
  }
  node.notes.push(note);
 }
 return root;
}
export function folderPaths(tree){return tree.folders.flatMap(folder=>[folder.path,...folderPaths(folder)])}
export function noteSnapshot(notes,active){return {activeId:active,kind:'browser-drafts',notes:notes.map(({id,name,folder})=>({id,name,folder}))}}
