// Run with the candidate's bundled Node; exercise the retained native modules.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve,join} from 'node:path';
import {realpath,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const app=resolve(process.argv[2]);
const output=resolve(process.argv[3]);
assert.equal(await realpath(process.execPath),await realpath(join(app,'Contents/Resources/runtimes/node/bin/node')));
const require=createRequire(join(app,'Contents/Resources/app/apps/desktop/package.json'));
const sharp=require('sharp');
const image=await sharp({create:{width:2,height:3,channels:4,background:'#3578bd'}}).png().toBuffer();
const metadata=await sharp(image).metadata();
assert.equal(metadata.width,2);assert.equal(metadata.height,3);
const pty=require('node-pty');
let terminal;
const text=await new Promise((resolve,reject)=>{
  let text='';
  const timer=setTimeout(()=>{terminal?.kill();reject(Error('Target arm64 PTY timed out'));},10000);
  terminal=pty.spawn('/usr/bin/printf',['PTY_ARM64_OK'],{cwd:tmpdir(),env:{PATH:'/usr/bin:/bin',HOME:tmpdir(),TERM:'xterm-256color'},cols:80,rows:24});
  terminal.onData(data=>text+=data);
  terminal.onExit(({exitCode})=>{clearTimeout(timer);try{assert.equal(exitCode,0);resolve(text);}catch(error){reject(error);}});
});
assert.equal(text,'PTY_ARM64_OK');
const report={passed:true,bundledNode:true,architecture:process.arch,sharp:{width:metadata.width,height:metadata.height,libvips:sharp.versions.vips},pty:{target:'darwin-arm64',spawnAndExit:true},modelCalls:0};
await writeFile(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
