// Navigation uses the same parsed Markdown tokens as the reading view.
export function installWikiLinks(md){
  md.inline.ruler.before('link','wikilink',(state,silent)=>{
    if(state.src.slice(state.pos,state.pos+2)!=='[[')return false;
    const end=state.src.indexOf(']]',state.pos+2);
    if(end<0)return false;
    const raw=state.src.slice(state.pos+2,end);
    if(!silent){
      const [target,label]=raw.split('|');
      const open=state.push('link_open','a',1);
      open.attrSet('href','#note='+encodeURIComponent(target));
      open.meta={wikiTarget:target};
      state.push('text','',0).content=label??target;
      state.push('link_close','a',-1);
    }
    state.pos=end+2;
    return true;
  });
}

export function parseNavigation(md,source){
  const env={},tokens=md.parse(source,env),headings=[],wikiTargets=new Set();
  const collectLinks=items=>{
    for(const token of items){
      // Code and image alt text do not contain navigable note links.
      if(token.type==='code_inline'||token.type==='image')continue;
      if(token.type==='link_open'&&typeof token.meta?.wikiTarget==='string')wikiTargets.add(token.meta.wikiTarget);
      if(token.children)collectLinks(token.children);
    }
  };
  for(const token of tokens){
    if(token.type==='heading_open'&&token.map){
      headings.push({index:headings.length,line:token.map[0]+1,level:Number(token.tag.slice(1))});
    }
  }
  collectLinks(tokens);
  return {tokens,env,headings,wikiTargets};
}
