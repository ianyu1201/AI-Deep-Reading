/** Offline compatibility copy only. Never selects an active knowledge root or mutates source. */
import {lstat,readdir,readFile,mkdir,writeFile,rename,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code});
const inside=(base,value)=>value===base||value.startsWith(base+path.sep);
async function absent(file){try{await lstat(file);return false;}catch(e){if(e.code==='ENOENT')return true;throw e;}}
export async function createKnowledgeCompatibilityCopy({sourceRoot,destinationRoot,maxFiles=10000,maxBytes=256*1024*1024}){
 if(!path.isAbsolute(sourceRoot??'')||!path.isAbsolute(destinationRoot??''))throw fail('INVALID_PATH','Source and destination must be absolute');
 if((await lstat(sourceRoot)).isSymbolicLink())throw fail('SOURCE_SYMLINK','Choose an actual source directory');
 const source=await realpath(sourceRoot);
 if(!(await lstat(source)).isDirectory())throw fail('INVALID_SOURCE','Source must be a directory');
 // Existing parent is required; this tool must not create unknown ancestor directories.
 const parent=await realpath(path.dirname(destinationRoot));
 const target=path.join(parent,path.basename(destinationRoot));
 if(inside(source,target)||inside(target,source))throw fail('OVERLAPPING_ROOTS','Source and target must be independent');
 if(!await absent(target))throw fail('TARGET_EXISTS','Target already exists; no files were overwritten');
 const records=[],skipped=[];let bytes=0;
 async function scan(rel=''){
  for(const entry of await readdir(path.join(source,rel),{withFileTypes:true})){
   const id=rel?rel+'/'+entry.name:entry.name;
   if(entry.name.startsWith('.')||entry.isSymbolicLink()){skipped.push({path:id,reason:'hidden-or-symlink'});continue;}
   if(entry.isDirectory()){await scan(id);continue;}
   if(!entry.isFile()||!id.toLowerCase().endsWith('.md')){skipped.push({path:id,reason:'not-markdown'});continue;}
   const file=path.join(source,id),before=await lstat(file);
   if(before.isSymbolicLink()||!(await realpath(file)).startsWith(source+path.sep))throw fail('SOURCE_CHANGED','Source entry changed');
   if(before.size>5*1024*1024)throw fail('FILE_LIMIT','A Markdown file exceeds 5 MiB');
   const data=await readFile(file),after=await lstat(file);
   if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||data.length!==before.size)throw fail('SOURCE_CHANGED','Source changed while taking the snapshot');
   bytes+=data.length;
   if(records.length>=maxFiles||bytes>maxBytes)throw fail('COPY_LIMIT','Compatibility copy exceeds limits');
   records.push({path:id,bytes:data.length,sha256:digest(data),data});
  }
 }
 await scan();
 // Exclusive mkdir serializes competing copies; never merge into an existing tree.
 await mkdir(target,{mode:0o700});
 const manifest={version:1,purpose:'knowledge-compatibility-copy',state:'copying',sourceReadOnly:true,createdAt:new Date().toISOString(),files:records.map(({data,...r})=>r),skipped,externalSourcesMigrated:false};
 const manifestPath=path.join(target,'.compatibility-copy.json');
 await writeFile(manifestPath,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
 try{
  for(const item of records){
   const dest=path.join(target,item.path);await mkdir(path.dirname(dest),{recursive:true,mode:0o700});
   await writeFile(dest,item.data,{flag:'wx',mode:0o600});
   if(digest(await readFile(dest))!==item.sha256)throw fail('COPY_VERIFY_FAILED','Copied bytes did not verify');
  }
  manifest.state='complete';manifest.bytes=bytes;
  const temp=manifestPath+'.'+randomUUID();await writeFile(temp,JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});await rename(temp,manifestPath);
  return {destination:target,...manifest};
 }catch(error){throw fail('COPY_INCOMPLETE','Copy is incomplete; original directory is unchanged. Inspect destination manifest before reuse.');}
}
