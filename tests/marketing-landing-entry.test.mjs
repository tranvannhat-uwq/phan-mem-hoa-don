import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const landingMotion = readFileSync(new URL('../js/landing-motion.js', import.meta.url), 'utf8');
const landingCss = readFileSync(new URL('../landing.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const users = readFileSync(new URL('../js/components/users.js', import.meta.url), 'utf8');

test('marketing landing replaces the customer-care Google Sheet page', () => {
  assert.match(html, /class="landing-page" id="landing-page"/);
  assert.match(html, /Quản lý bán hàng[\s\S]*gọn hơn mỗi ngày/);
  assert.match(html, /id="features"[\s\S]*id="solutions"[\s\S]*id="benefits"/);
  assert.doesNotMatch(html, /customer-care-landing|care-sheet-frame|Chọn danh sách khách hàng của bạn/);
  assert.match(html, /href="landing\.css[^\"]*"/);
  assert.ok(html.indexOf('ui-system.css') < html.indexOf('landing.css'));
  assert.match(html, /src="js\/landing-motion\.js[^\"]*"/);
  assert.doesNotMatch(html, /customer-care-landing\.js/);
});

test('landing closing section keeps premium contrast above the system theme', () => {
  assert.match(landingCss, /#landing-page \.landing-benefits h2\s*\{[\s\S]*color:\s*#ffffff/);
  assert.match(landingCss, /#landing-page \.landing-benefits\s*\{[\s\S]*linear-gradient\(125deg, #061b2d/);
  assert.match(landingCss, /#landing-page \.landing-footer\s*\{[\s\S]*background:\s*rgba\(255, 255, 255, \.92\)/);
  assert.match(landingCss, /Final footer containment:[\s\S]*padding:\s*46px 52px 24px/);
  assert.match(landingCss, /grid-template-columns:\s*minmax\(180px, 1\.05fr\)[\s\S]*minmax\(150px, \.9fr\)/);
});

test('landing login opens the workspace without adding a route', () => {
  assert.match(html, /class="landing-login-button js-open-login"/);
  assert.match(landingMotion, /querySelectorAll\('\.js-open-login'\)/);
  assert.match(landingMotion, /sessionStorage\.setItem\(WORKSPACE_REQUEST_STORAGE_KEY, '1'\)/);
  assert.match(landingMotion, /window\.location\.reload\(\)/);
  assert.doesNotMatch(`${landingMotion}\n${main}`, /#\/ban-hang|SALES_WORKSPACE_HASH/);
});

test('closing login and logging out return to the landing page', () => {
  assert.match(main, /workspaceRequested = sessionStorage\.getItem\(WORKSPACE_REQUEST_STORAGE_KEY\) === '1'/);
  assert.match(main, /getElementById\('btn-close-login'\)[\s\S]{0,220}loginScreen\.style\.display = 'none'/);
  const logoutFlow = users.slice(users.indexOf('export async function handleLogout'), users.indexOf('export function showLoginGate'));
  assert.match(logoutFlow, /sessionStorage\.removeItem\('sovie_workspace_requested'\)/);
  assert.match(logoutFlow, /window\.location\.replace\(`\$\{window\.location\.pathname\}\$\{window\.location\.search\}`\)/);
});
