import {build} from 'esbuild';
import {cp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(fileURLToPath(import.meta.url));
const out=resolve(root,'dist');
// Fail closed if a future upstream update restores executable EPUB content.
for(const name of ['paginator.js','fixed-layout.js']){
  const source=await readFile(resolve(root,'vendor/foliate-js',name),'utf8');
  if(source.includes('allow-scripts')||!source.includes("'sandbox', 'allow-same-origin'"))
    throw new Error(`Unreviewed EPUB sandbox in ${name}`);
  if(source.includes('.srcdoc')) throw new Error(`Unexpected srcdoc compatibility patch in ${name}`);
}
await rm(out,{recursive:true,force:true});
await mkdir(out,{recursive:true});
// Each document gets the same canonical palette without relaxing its CSP.
const theme=resolve(root,'../ui-theme/theme.css');
await cp(theme,resolve(out,'theme.css'));
await cp(theme,resolve(root,'../../apps/desktop/shell/theme.css'));
for(const name of ['motion.js','motion.css','appearance.js']) { await cp(resolve(root,'../ui-theme',name),resolve(out,name)); await cp(resolve(root,'../ui-theme',name),resolve(root,'../../apps/desktop/shell',name)); }
// SVG masks and inline reader SVGs come from exactly the same Lucide nodes.
const {nodes}=await import('./src/icon-map.js');
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;');
for(const [name,node] of Object.entries(nodes)){
 const filename=name.replace(/([a-z0-9])([A-Z])/g,'$1-$2').toLowerCase()+'.svg';
 const svg='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">'+node.map(([tag,attrs])=>'<'+tag+' '+Object.entries(attrs).map(([k,v])=>k+'="'+escape(v)+'"').join(' ')+'/>').join('')+'</svg>';
 await writeFile(resolve(root,'../../apps/desktop/shell/icons',filename),svg);
}
await build({entryPoints:[resolve(root,'../../apps/desktop/shell/markdown-source.js')],outfile:resolve(root,'../../apps/desktop/shell/safe-markdown.js'),bundle:true,format:'esm',platform:'browser',target:'chrome120'});
const result=await build({
  absWorkingDir:root,
  entryPoints:['src/books.js','src/markdown.js'],outdir:out,
  bundle:true,format:'esm',platform:'browser',target:'chrome120',
  splitting:true,minify:false,metafile:true,legalComments:'external'
});
for(const name of ['books.html','markdown.html','books.css','markdown.css'])
  await cp(resolve(root,'src',name),resolve(out,name));
await cp(resolve(root,'fixtures/books-assets'),resolve(out,'books-assets'),{recursive:true});
await cp(resolve(root,'vendor/foliate-js/LICENSE'),resolve(out,'FOLIATE-LICENSE'));
await cp(resolve(root,'vendor/licenses'),resolve(out,'licenses'),{recursive:true});
const packages=new Set(Object.keys(result.metafile.inputs).flatMap(path=>{
  const match=path.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/);
  return match?[match[1]]:[];
}));
const notices=[];
for(const name of [...packages].sort()){
  const directory=resolve(root,'node_modules',name);
  const metadata=JSON.parse(await readFile(resolve(directory,'package.json'),'utf8'));
  const files=(await readdir(directory)).filter(name=>/^(license|notice)([._-]|$)/i.test(name));
  if(!files.length)throw new Error(`Missing npm license notice: ${name}`);
  for(const file of files){
    const target=resolve(out,'licenses/npm',name,file);
    await mkdir(dirname(target),{recursive:true});await cp(resolve(directory,file),target);
  }
  notices.push({name,version:metadata.version,license:metadata.license,files});
}
await writeFile(resolve(out,'licenses/npm-packages.json'),JSON.stringify(notices,null,2)+'\n');
await cp(resolve(root,'THIRD_PARTY.md'),resolve(out,'THIRD_PARTY.md'));
await writeFile(resolve(out,'build-meta.json'),JSON.stringify(result.metafile,null,2)+'\n');
console.log(`Built independent reader pages: ${out}`);
