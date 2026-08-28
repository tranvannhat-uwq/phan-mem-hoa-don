import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const landing = readFileSync(new URL('../js/customer-care-landing.js', import.meta.url), 'utf8');
const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');

test('private Google data status opens the login route after five consecutive clicks', () => {
  assert.match(html, /<button[^>]+id="care-private-data-access"[^>]*>[\s\S]*?Dữ liệu riêng tư qua Google[\s\S]*?<\/button>/);
  assert.match(landing, /getElementById\('care-private-data-access'\)/);
  assert.match(landing, /clickCount === 5[\s\S]*window\.location\.hash = SALES_WORKSPACE_HASH/);
});

test('closing login removes the sales workspace hash and returns to customer care', () => {
  assert.match(main, /getElementById\('btn-close-login'\)[\s\S]{0,180}window\.location\.replace\(`\$\{window\.location\.pathname\}\$\{window\.location\.search\}`\)/);
});
