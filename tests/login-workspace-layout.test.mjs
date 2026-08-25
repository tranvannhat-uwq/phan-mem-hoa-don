import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('login screen uses the responsive workspace layout without changing auth bindings', () => {
  const html = read('index.html');
  const css = read('style.css');
  const main = read('js/main.js');
  const users = read('js/components/users.js');

  assert.match(html, /class="login-showcase"[\s\S]*class="login-form-panel"/);
  assert.match(html, /id="login-form"[\s\S]*id="login-username"[\s\S]*id="login-password"[\s\S]*id="btn-login-submit"/);
  assert.match(html, /id="login-remember-account"[\s\S]*id="btn-forgot-password"/);
  assert.match(css, /\.login-card\s*\{[\s\S]*grid-template-columns:[\s\S]*width:\s*min\(1200px, calc\(100vw - 96px\)\)[\s\S]*height:\s*clamp\(760px, calc\(100vh - 96px\), 800px\)/);
  assert.match(css, /@media \(max-width: 820px\)[\s\S]*\.login-showcase\s*\{\s*display:\s*none;/);
  assert.match(main, /loginForm\.addEventListener\('submit', handleLogin\)/);
  assert.match(main, /sovie_remembered_login_account/);
  assert.match(html, /id="btn-forgot-password"[^>]*onclick="[^"]*liên hệ quản trị viên/);
  assert.match(users, /document\.getElementById\('login-username'\)[\s\S]*document\.getElementById\('login-password'\)/);
});
