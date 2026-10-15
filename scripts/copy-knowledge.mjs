import path from 'node:path';
import {createKnowledgeCompatibilityCopy} from '../apps/desktop/runtime/knowledge-compatibility-copy.mjs';
const [sourceRoot,destinationRoot,...extra]=process.argv.slice(2);
if(!sourceRoot||!destinationRoot||extra.length||!path.isAbsolute(sourceRoot)||!path.isAbsolute(destinationRoot)){
 console.error('Usage: node scripts/copy-knowledge.mjs /absolute/source/45-书籍 /absolute/new/45-书籍-copy');
 process.exitCode=2;
}else{
 try{const r=await createKnowledgeCompatibilityCopy({sourceRoot,destinationRoot});console.log(JSON.stringify({state:r.state,destination:r.destination,files:r.files.length,bytes:r.bytes,skipped:r.skipped,externalSourcesMigrated:false},null,2));}
 catch(error){console.error(JSON.stringify({code:error.code??'COPY_FAILED',message:error.message}));process.exitCode=1;}
}
