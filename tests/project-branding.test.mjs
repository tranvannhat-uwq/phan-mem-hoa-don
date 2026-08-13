import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('EMP One is the primary project brand in navigation and login', () => {
  const html = read('index.html');
  const logoReferences = html.match(/src="empone-logo\.png"/g) || [];

  assert.equal(logoReferences.length, 2);
  assert.match(html, /class="brand-project-logo"[\s\S]*alt="EMP One"/);
  assert.match(html, /class="login-brand-lockup"[\s\S]*alt="EMP One"/);
  assert.doesNotMatch(html, /<span class="brand-name"[^>]*>KIOT NANO<\/span>/);
  assert.doesNotMatch(html, /class="login-logo"/);
});

test('project logo presentation is prominent and responsive', () => {
  const css = read('style.css');

  assert.match(css, /\.brand-project-logo\s*\{[\s\S]*background:\s*#ffffff;[\s\S]*box-shadow:/);
  assert.match(css, /\.login-brand-lockup\s*\{[\s\S]*width:\s*min\(270px, 88%\);[\s\S]*box-shadow:/);
  assert.match(css, /@media \(max-width: 768px\)[\s\S]*\.brand-project-logo\s*\{[\s\S]*width:\s*112px;/);
  assert.match(css, /\.brand-project-logo img[\s\S]*object-fit:\s*contain;/);
  assert.match(css, /\.login-brand-lockup img[\s\S]*object-fit:\s*contain;/);
});
