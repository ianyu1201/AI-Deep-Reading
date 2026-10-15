const themes = new Set(['paper','white','dark']);
// Old versions persisted the default on every layout, so a stored theme without
// provenance is ambiguous. Preserve it; never guess that it wasn't chosen.
export function readingPrefs(saved = {}) {
  const hasTheme = themes.has(saved?.theme);
  return {font:18,spacing:1.6,flow:'scrolled',...saved,
    theme:hasTheme?saved.theme:'white',
    themeOrigin:hasTheme?(saved.themeOrigin==='automatic'?'automatic':saved.themeOrigin==='user'?'user':'legacy'):'automatic'};
}
export function effectiveTheme(prefs, immersive) {
  return prefs.themeOrigin==='automatic'?(immersive?'paper':'white'):prefs.theme;
}
export function readingPalette(node) {
  const style=getComputedStyle(node);
  return Object.fromEntries(['paper','ink','muted','link','selection','selection-text'].map(name=>[name,style.getPropertyValue('--reading-'+name).trim()]));
}

// Container mode owns layout. Keep legacy flow preferences untouched for migration;
// they must not override ordinary scrolling or immersive pagination.
export function effectiveFlow(immersive) { return immersive ? 'paginated' : 'scrolled'; }
