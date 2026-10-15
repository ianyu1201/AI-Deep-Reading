import {mkdir, open, rename, unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

/** Shared write mechanism only; callers own schemas, validation and queues. */
export async function writeAtomicJson({root, file, value, beforeCommit}) {
 await mkdir(root,{recursive:true,mode:0o700});
 const temp=file+'.'+randomUUID()+'.tmp';let handle;
 try {
  handle=await open(temp,'wx',0o600);
  await handle.writeFile(JSON.stringify(value,null,2));
  await handle.sync();
  await handle.close();handle=null;
  await beforeCommit();
  await rename(temp,file);
 } finally {
  await handle?.close();
  await unlink(temp).catch(()=>{});
 }
}
