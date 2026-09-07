import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('employee account creation stays behind an authenticated admin Edge Function', () => {
  const edge = read('supabase/functions/admin-create-user/index.ts');
  const users = read('js/components/users.js');
  const service = read('js/services/supabase.js');

  assert.match(edge, /auth\.getUser\(\)/);
  assert.match(edge, /callerProfile\?\.role !== 'admin'/);
  assert.match(edge, /auth\.admin\.createUser/);
  assert.match(edge, /auth\.admin\.updateUserById/);
  assert.match(edge, /email_confirm:\s*true/);
  assert.match(edge, /auth\.admin\.deleteUser/);
  assert.match(service, /functions\.invoke\('admin-create-user'/);
  assert.doesNotMatch(`${users}\n${service}`, /SUPABASE_SERVICE_ROLE_KEY|service_role/i);
  assert.doesNotMatch(users, /Tạo tài khoản đăng nhập trong Supabase Auth trước/);
});

test('a deleted login account can be reactivated with a new password', () => {
  const edge = read('supabase/functions/admin-create-user/index.ts');
  const users = read('js/components/users.js');

  assert.match(edge, /\.ilike\('username', email\)/);
  assert.match(edge, /existingProfile\?\.is_active === true/);
  assert.match(edge, /password,[\s\S]{0,120}email_confirm:\s*true/);
  assert.match(edge, /is_active:\s*true/);
  assert.match(edge, /reactivated:\s*true/);
  assert.match(edge, /auth\.admin\.listUsers/);
  assert.match(edge, /auth_user_id:\s*authUser\.id/);
  assert.match(edge, /createdAuthForLegacyProfile/);
  assert.doesNotMatch(edge, /Tài khoản cũ chưa được liên kết Supabase Auth/);
  assert.match(users, /isSameUser\(u\.username, username\)[\s\S]{0,120}u\.isActive !== false/);
});

test('new login accounts require an initial password without storing it in the profile', () => {
  const html = read('index.html');
  const users = read('js/components/users.js');
  const service = read('js/services/supabase.js');

  assert.match(html, /id="user-password"[^>]*type="password"|type="password"[^>]*id="user-password"/);
  assert.match(users, /initialPassword\.length < 8/);
  assert.doesNotMatch(service.match(/const dbRow = \{[\s\S]*?\n\s*\};/)?.[0] || '', /password/);
});

test('an Admin can reset an existing employee password without changing their profile', () => {
  const html = read('index.html');
  const edge = read('supabase/functions/admin-create-user/index.ts');
  const users = read('js/components/users.js');
  const service = read('js/services/supabase.js');

  assert.match(html, /id="user-password-label"/);
  assert.match(users, /Cấp lại mật khẩu \(tùy chọn\)/);
  assert.match(users, /Mật khẩu cấp lại phải có ít nhất 8 ký tự/);
  assert.match(service, /operation: isNew \? 'create' : 'reset_password'/);
  assert.match(service, /profileId: isNew \? undefined : user\.id/);
  assert.match(edge, /requestedOperation/);
  assert.match(edge, /operation === 'reset_password'/);
  assert.match(edge, /targetProfile\.auth_user_id/);
  assert.match(edge, /auth\.admin\.updateUserById\([\s\S]*\{ password \}/);
  assert.match(edge, /reset_employee_password/);
  assert.doesNotMatch(edge, /password_reset:\s*true[^\n]*password/);
  assert.match(users, /Đã cấp lại mật khẩu đăng nhập thành công/);
});

test('password-reset code uses a fresh browser module version', () => {
  const html = read('index.html');
  const main = read('js/main.js');
  const users = read('js/components/users.js');
  const realtime = read('js/services/realtime.js');
  const version = '20260907-password-reset-v2';

  assert.match(html, new RegExp(`main\\.js\\?v=${version}`));
  assert.match(main, new RegExp(`services/supabase\\.js\\?v=${version}`));
  assert.match(main, new RegExp(`components/users\\.js\\?v=${version}`));
  assert.match(users, new RegExp(`services/supabase\\.js\\?v=${version}`));
  assert.match(users, new RegExp(`main\\.js\\?v=${version}`));
  assert.match(realtime, new RegExp(`supabase\\.js\\?v=${version}`));
});
