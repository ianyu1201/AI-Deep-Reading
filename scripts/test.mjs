import {spawnSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const tests=async directory=>(await readdir(resolve(root,directory))).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>resolve(root,directory,name));
// Tests use temporary or synthetic data and must not inherit a real-model opt-in.
const env={...Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL'].filter(name=>process.env[name]).map(name=>[name,process.env[name]])),AI_READING_USE_HOST_MODEL:'0',AI_READING_DISABLE_AI:'1'};
const run=(command,args,cwd=root)=>{
  const result=spawnSync(command,args,{cwd,env,stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
};
run(process.execPath,['--test',...await tests('packages/reader-ui/tests')]);
run(process.execPath,['--test',...await tests('packages/book-library'),...await tests('packages/guide-generation')]);
run(process.execPath,['--test',...await tests('apps/desktop/runtime'),...await tests('apps/desktop/tests')],resolve(root,'apps/desktop'));
run(process.execPath,['--test',...await tests('dsh-apple-read/tests')],resolve(root,'dsh-apple-read'));
run('python3',['-m','unittest','discover','-s','packages/book-library','-p','test_library.py','-v']);
run('python3',['scripts/test_open_client.py']);
run('python3',['-B','scripts/test_audit_release.py']);
