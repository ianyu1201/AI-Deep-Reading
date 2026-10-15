import MarkdownIt from '../../../packages/reader-ui/node_modules/markdown-it/dist/markdown-it.mjs';
// Same parser policy as the Markdown reader: no raw HTML, no automatic links.
const parser=new MarkdownIt({html:false,linkify:false,breaks:true});
export function renderMarkdown(node,text){node.classList.add('business-markdown');node.innerHTML=parser.render(String(text??''));for(const link of node.querySelectorAll('a')){link.removeAttribute('href');link.title='引用链接请通过原文操作打开';}}
