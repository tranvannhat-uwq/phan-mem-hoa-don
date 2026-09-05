import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const landing = readFileSync(new URL('../js/customer-care-landing.js', import.meta.url), 'utf8');
const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const users = readFileSync(new URL('../js/components/users.js', import.meta.url), 'utf8');

test('private Google data status opens the login route after five consecutive clicks', () => {
  assert.match(html, /<button[^>]+id="care-private-data-access"[^>]*>[\s\S]*?Dữ liệu riêng tư qua Google[\s\S]*?<\/button>/);
  assert.match(landing, /getElementById\('care-private-data-access'\)/);
  assert.match(landing, /clickCount === 5[\s\S]*window\.location\.hash = SALES_WORKSPACE_HASH/);
});

test('private account badge redirects to sovie.io.vn after six consecutive clicks', () => {
  assert.match(html, /<button[^>]+id="care-private-redirect"[^>]*>[\s\S]*?Riêng tư[\s\S]*?Theo tài khoản[\s\S]*?<\/button>/);
  assert.match(landing, /getElementById\('care-private-redirect'\)/);
  assert.match(landing, /clickCount === 6[\s\S]*window\.location\.href = PRIVATE_BADGE_REDIRECT_URL/);
  assert.match(landing, /PRIVATE_BADGE_REDIRECT_URL = 'https:\/\/sovie\.io\.vn'/);
});

test('closing login removes the sales workspace hash and returns to customer care', () => {
  assert.match(main, /getElementById\('btn-close-login'\)[\s\S]{0,180}window\.location\.replace\(`\$\{window\.location\.pathname\}\$\{window\.location\.search\}`\)/);
});

test('each salesperson selects and reuses their own Google Sheet link', () => {
  assert.match(html, /id="care-sheet-config-form"[\s\S]*id="care-sheet-url"[\s\S]*Lưu và mở danh sách/);
  assert.match(html, /id="care-sheet-settings"[\s\S]*Đổi bảng/);
  assert.doesNotMatch(html, /CRM - TRẦN VĂN NHẤT|1yC4VnrziHCUyvgaknSbcg2HkLqmMOp0ApM3mxo_jAGA/);
  assert.match(landing, /CUSTOMER_CARE_SHEET_STORAGE_KEY = 'sovie_customer_care_sheet_url'/);
  assert.match(landing, /localStorage\.setItem\(CUSTOMER_CARE_SHEET_STORAGE_KEY, parsed\.editUrl\)/);
  assert.match(landing, /localStorage\.getItem\(CUSTOMER_CARE_SHEET_STORAGE_KEY\)/);
  assert.match(landing, /url\.hostname !== 'docs\.google\.com'/);
});

test('logout is a direct navbar action and returns to the customer-care home', () => {
  assert.match(html, /class="nav-logout-button" id="btn-logout"[^>]*>[\s\S]*?Đăng xuất[\s\S]*?<\/button>/);
  assert.doesNotMatch(html, /class="dropdown-item" id="btn-logout"/);
  const logoutFlow = users.slice(users.indexOf('export async function handleLogout'), users.indexOf('export function showLoginGate'));
  assert.match(logoutFlow, /await supabaseClient\.auth\.signOut\(\)/);
  assert.match(logoutFlow, /window\.location\.replace\(`\$\{window\.location\.pathname\}\$\{window\.location\.search\}`\)/);
  assert.doesNotMatch(logoutFlow, /location\.reload\(\)/);
});
