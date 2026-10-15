import {syntaxTree} from '@codemirror/language';
import {StateEffect} from '@codemirror/state';
import {Decoration,ViewPlugin} from '@codemirror/view';

// Independently implemented from the observed rules, using the public CM parser.
// No Obsidian code is included in this module.
export function previewPlan(state,{focused=false,ranges=[{from:0,to:state.doc.length}]}={}) {
  const plan=[], exclusions=[], selections=focused?state.selection.ranges:[];
  const touches=(from,to)=>selections.some(s=>s.from<=to&&s.to>=from);
  const visible=(from,to)=>ranges.some(r=>r.from<=to&&r.to>=from);
  const add=(kind,from,to,cls)=>{if(to>from||kind==='line')plan.push({kind,from,to,cls})};
  const hide=(from,to)=>{if(!state.sliceDoc(from,to).includes('\n'))add('hide',from,to)};
  syntaxTree(state).iterate({enter(node){
    const {name,from,to}=node;
    if(['FencedCode','CodeBlock','HTMLBlock','InlineCode','Escape'].includes(name)) {
      exclusions.push({from,to});
      // Preserve literal source within code; no markdown replacements inside it.
      return false;
    }
    if(!visible(from,to))return false;
    if(/^ATXHeading[1-6]$/.test(name)) {
      const line=state.doc.lineAt(from), level=Number(name.slice(-1));
      add('line',line.from,line.from,'cm-h'+Math.min(level,3));
      if(!touches(line.from,line.to))for(let c=node.node.firstChild;c;c=c.nextSibling) {
        if(c.name==='HeaderMark') {
          let end=c.to;if(c.from===from&&state.sliceDoc(end,end+1)===' ')end++;
          hide(c.from,end);
        }
      }
    }
    if(name==='QuoteMark') {
      const line=state.doc.lineAt(from);add('line',line.from,line.from,'cm-quote-line');
      if(!touches(line.from,line.to))hide(from,to+(state.sliceDoc(to,to+1)===' '?1:0));
    }
    if(name==='StrongEmphasis'||name==='Emphasis') {
      add('mark',from,to,name==='StrongEmphasis'?'cm-strong':'cm-em');
      if(!touches(from,to))for(let c=node.node.firstChild;c;c=c.nextSibling)
        if(c.name==='EmphasisMark')hide(c.from,c.to);
    }
  }});
  const seen=new Set();
  for(const range of ranges)for(let number=state.doc.lineAt(range.from).number;number<=state.doc.lineAt(range.to).number;number++) {
    if(seen.has(number))continue;seen.add(number);
    const line=state.doc.line(number);
    for(const match of line.text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
      const from=line.from+match.index,to=from+match[0].length;
      const prefix=line.text.slice(0,match.index),slashes=/\\*$/.exec(prefix)[0].length;
      if(slashes%2||prefix.endsWith('!')||exclusions.some(x=>from<x.to&&to>x.from))continue;
      add('mark',from,to,'cm-wikilink');
      if(!touches(from,to)) {
        const pipe=match[1].indexOf('|');
        // Preserve empty/incomplete aliases as source, so they remain editable.
        if(pipe>=0&&!match[1].slice(pipe+1).trim())continue;
        hide(from,from+2+(pipe<0?0:pipe+1));hide(to-2,to);
      }
    }
  }
  return plan;
}

function decorations(view) {
  const plan=previewPlan(view.state,{focused:view.hasFocus,ranges:view.visibleRanges});
  const hidden=plan.filter(x=>x.kind==='hide').sort((a,b)=>a.from-b.from||a.to-b.to), merged=[];
  for(const x of hidden){const last=merged.at(-1);if(last&&x.from<=last.to)last.to=Math.max(last.to,x.to);else merged.push({...x})}
  const result=merged.map(x=>Decoration.replace({}).range(x.from,x.to));
  const lines=new Set();
  for(const x of plan) {
    if(x.kind==='mark')result.push(Decoration.mark({class:x.cls}).range(x.from,x.to));
    if(x.kind==='line'&&!lines.has(x.from+':'+x.cls)) {
      lines.add(x.from+':'+x.cls);result.push(Decoration.line({class:x.cls}).range(x.from));
    }
  }
  return Decoration.set(result,true);
}
const refresh=StateEffect.define();
export const livePreview=ViewPlugin.fromClass(class {
  constructor(view){this.decorations=decorations(view);this.timer=null;this.destroyed=false}
  update(update){
    if(update.view.composing){this.decorations=this.decorations.map(update.changes);return}
    if(update.docChanged||update.selectionSet||update.focusChanged||update.viewportChanged||syntaxTree(update.startState)!==syntaxTree(update.state)||update.transactions.some(t=>t.effects.some(e=>e.is(refresh))))this.decorations=decorations(update.view);
  }
  destroy(){this.destroyed=true;clearTimeout(this.timer)}
},{decorations:p=>p.decorations,eventHandlers:{compositionend(event,view){
  clearTimeout(this.timer);this.timer=setTimeout(()=>{if(!this.destroyed)view.dispatch({effects:refresh.of(null)})},50);
}}});
