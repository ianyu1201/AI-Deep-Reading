import {spawnSync} from 'node:child_process';
for(const directory of ['apps/desktop','packages/reader-ui']){
  const result=spawnSync('npm',['ci','--no-audit','--no-fund'],{cwd:new URL(directory+'/',new URL('../',import.meta.url)),stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
console.log('Dependencies installed. Run npm run build, then npm start.');
