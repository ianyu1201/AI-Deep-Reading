import {access,readFile,realpath,readdir,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

const targets={darwin:{arm64:'aarch64-apple-darwin',x64:'x86_64-apple-darwin'},linux:{arm64:'aarch64-unknown-linux-musl',x64:'x86_64-unknown-linux-musl'}};
async function native(file){
 try{await access(file,constants.X_OK);const handle=await open(file,'r');let data=Buffer.alloc(4);try{await handle.read(data,0,4,0);}finally{await handle.close();}const magic=data.toString('hex');return ['cffaedfe','feedfacf','cafebabe','bebafeca','7f454c46'].includes(magic);}catch{return false;}
}
/** Resolve an installed official npm launcher without executing its JS or consulting auth. */
export async function unwrapCodex(candidate,{platform=process.platform,arch=process.arch}={}){
 let absolute;try{absolute=await realpath(candidate);}catch{return null;}
 if(await native(absolute))return absolute;
 if(path.basename(absolute)!=='codex.js')return null;
 const packageRoot=path.resolve(path.dirname(absolute),'..');
 try{
  const meta=JSON.parse(await readFile(path.join(packageRoot,'package.json'),'utf8'));
  if(meta.name!=='@openai/codex')return null;
  const target=targets[platform]?.[arch];if(!target)return null;
  const optional=`@openai/codex-${platform}-${arch}`;
  let vendor=path.join(packageRoot,'vendor');
  try{vendor=path.join(path.dirname(createRequire(absolute).resolve(optional+'/package.json')),'vendor');}catch{}
  for(const file of [path.join(vendor,target,'bin/codex'),path.join(vendor,target,'codex/codex')])if(await native(file))return await realpath(file);
 }catch{}
 return null;
}
export async function resolveCodexPath({env=process.env,home=homedir(),platform=process.platform,arch=process.arch,applicationCandidates=['/Applications/Codex.app/Contents/Resources/codex','/Applications/Codex.app/Contents/Resources/bin/codex']}={}){
 const options={platform,arch};
 if(env.AI_READING_CODEX){
  if(!path.isAbsolute(env.AI_READING_CODEX))throw new Error('AI_READING_CODEX must be an absolute executable path');
  const result=await unwrapCodex(env.AI_READING_CODEX,options);
  if(!result)throw new Error('Explicit Codex executable is unavailable');
  return {path:result,source:'explicit'};
 }
 for(const directory of (env.PATH??'').split(path.delimiter).filter(value=>path.isAbsolute(value))){
  const result=await unwrapCodex(path.join(directory,'codex'),options);if(result)return {path:result,source:'PATH'};
 }
 for(const candidate of applicationCandidates){const result=await unwrapCodex(candidate,options);if(result)return {path:result,source:'official-application'};}
 // Only enumerate installed nvm toolchains; never evaluate shell startup files or read ~/.codex.
 const versions=path.join(home,'.nvm/versions/node');let entries=[];
 try{entries=(await readdir(versions,{withFileTypes:true})).filter(e=>e.isDirectory()&&/^v\d+\.\d+\.\d+$/.test(e.name)).map(e=>e.name).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));}catch{}
 for(const version of entries){const result=await unwrapCodex(path.join(versions,version,'bin/codex'),options);if(result)return {path:result,source:'installed-nvm'};}
 throw new Error('Codex CLI is unavailable; install the official CLI or configure AI_READING_CODEX');
}
