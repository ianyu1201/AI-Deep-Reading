(() => {
 const bridge=window.readingAppearance;
 if(!bridge)return;
 const apply=p=>{document.body.dataset.theme=p.resolved;document.body.dataset.accent=p.accent;window.dispatchEvent(new CustomEvent('ai-reading:appearance-applied',{detail:p}));};
 bridge.onChange(apply);bridge.get().then(apply);
})();
