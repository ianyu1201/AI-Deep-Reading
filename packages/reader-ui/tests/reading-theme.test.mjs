import test from 'node:test';
import assert from 'node:assert/strict';
import {readingPrefs,effectiveTheme,effectiveFlow} from '../src/reading-theme.js';
test('new preference follows neutral companion / subtle paper immersion without mutating choice',()=>{
 const prefs=readingPrefs();const copy=JSON.stringify(prefs);
 assert.equal(effectiveTheme(prefs,false),'white');assert.equal(effectiveTheme(prefs,true),'paper');
 assert.equal(JSON.stringify(prefs),copy);assert.equal(readingPrefs(JSON.parse(copy)).themeOrigin,'automatic');
});
test('legacy and explicit themes survive mode switches without guessing user intent',()=>{
 for(const theme of ['paper','white','dark'])for(const origin of [undefined,'user']){
  const saved={theme,font:24,spacing:1.9,...(origin?{themeOrigin:origin}:{})};
  const prefs=readingPrefs(saved);assert.equal(prefs.font,24);assert.equal(prefs.spacing,1.9);
  assert.equal(prefs.themeOrigin,origin??'legacy');assert.equal(effectiveTheme(prefs,false),theme);assert.equal(effectiveTheme(prefs,true),theme);
 }
});

test('container determines flow without changing saved legacy choice or theme',()=>{
 for(const flow of ['paginated','scrolled']){
  const prefs=readingPrefs({flow,theme:'dark',themeOrigin:'user'}),snapshot=JSON.stringify(prefs);
  assert.equal(effectiveFlow(false),'scrolled');assert.equal(effectiveFlow(true),'paginated');
  assert.equal(effectiveFlow(false),'scrolled');assert.equal(JSON.stringify(prefs),snapshot);
 }
 assert.equal(readingPrefs().flow,'scrolled');
});
