import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8');

test('landing feature cards use a restrained light hover treatment', () => {
  const hoverRule = css.match(/#landing-page \.feature-card:hover,\s*#landing-page \.feature-card:focus-visible\s*\{([^}]+)\}/)?.[1] || '';

  assert.match(hoverRule, /background:\s*#f1f6ff/);
  assert.match(hoverRule, /color:\s*#09263e/);
  assert.match(hoverRule, /translateY\(-3px\)/);
  assert.doesNotMatch(hoverRule, /background:\s*#075ff7|color:\s*#fff/);
  assert.match(css, /\.feature-card\.is-visible:hover\s*\{[\s\S]*?translateY\(-3px\)[\s\S]*?rgba\(37, 99, 235, \.11\)/);
});
