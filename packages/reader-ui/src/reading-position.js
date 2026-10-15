// An independent storage guard: layout events must not replace a stable bookmark.
export class ReadingPosition {
  constructor(write){this.write=write;this.generation=0;this.ready=false;this.locked=false;this.last=null;this.suspended=false;this.holdVersion=0}
  begin(){this.generation++;this.ready=false;this.locked=false;this.last=null;this.suspended=false;this.holdVersion=0}
  hold(){if(this.ready){this.suspended=true;this.holdVersion++}}
  observe(location){
    if(!this.ready||this.locked||this.suspended||!valid(location))return false;
    this.last={cfi:location.cfi,fraction:location.fraction};this.write(this.last);return true;
  }
  loaded(location){this.ready=true;return this.observe(location)}
  reflow(options){
    const token=this.generation;
    const work=(this.pending??Promise.resolve()).catch(()=>{}).then(()=>token===this.generation?this.performReflow(options):false);
    this.pending=work;
    return work;
  }
  async performReflow({apply,settle,restore}){
    const token=this.generation,anchor=this.last&&{...this.last};this.locked=true;
    try {
      let holdVersion;
      do {
        holdVersion=this.holdVersion;
        await apply();await settle();
        if(token!==this.generation)return false;
        if(anchor){await restore(anchor.cfi);await settle()}
        if(token!==this.generation)return false;
        // A resize/activation during layout needs one more pass, even when its caller
        // has no queued work. Otherwise suspended could outlive the reflow forever.
      } while(holdVersion!==this.holdVersion);
      if(anchor){this.last=anchor;this.write(anchor)}
      return true;
    } finally {if(token===this.generation){this.locked=false;this.suspended=false}}
  }
}
function valid(location){return typeof location?.cfi==='string'&&location.cfi.startsWith('epubcfi(')&&Number.isFinite(location.fraction)&&location.fraction>=0&&location.fraction<=1}

// Preserve the leading glyph when fractional scrolled coordinates round upward.
// Uses Foliate's own bounded scroll + relocation; never repaginates the book.
export async function ensureScrolledAnchorVisible(view,cfi){
 if(view.isFixedLayout||view.renderer?.getAttribute('flow')!=='scrolled')return;
 const resolved=view.resolveCFI(cfi),content=view.renderer.getContents().find(x=>x.index===resolved.index);
 const range=content&&resolved.anchor(content.doc),visible=view.lastLocation?.range;
 if(range&&visible&&visible.startContainer.ownerDocument===content.doc&&visible.comparePoint(range.startContainer,range.startOffset)<0&&view.renderer.start>0)
  await view.renderer.prev(Math.min(8,view.renderer.start));
}
