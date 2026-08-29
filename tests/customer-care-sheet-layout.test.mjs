import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('customer-care sheet uses a wide fit-to-columns workspace by default', () => {
  const html = read('index.html');
  const css = read('style.css');
  const landing = read('js/customer-care-landing.js');

  assert.match(html, /id="care-sheet-fit"[\s\S]*id="care-sheet-actual"[\s\S]*id="care-sheet-fullscreen"/);
  assert.match(html, /id="care-sheet-frame-wrap"/);
  assert.match(landing, /const virtualWidth = availableWidth < 760 \? 1380 : 1800/);
  assert.match(landing, /new ResizeObserver\(\(\) => applyFrameLayout\(\)\)/);
  assert.match(landing, /requestFullscreen\(\)/);
  assert.match(css, /height: clamp\(620px, calc\(100vh - 226px\), 1100px\)/);
  assert.match(css, /\.care-sheet-card:fullscreen/);
});
