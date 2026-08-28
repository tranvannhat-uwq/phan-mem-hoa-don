import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('deactivated accounts stay hidden while historical profile data is retained', () => {
  const users = read('js/components/users.js');
  const service = read('js/services/supabase.js');
  const deleteFunction = service.match(/export async function dbDeleteUser[\s\S]*?\n\}/)?.[0] || '';

  assert.match(users, /u\.isActive === false \|\| u\.is_active === false/);
  assert.match(deleteFunction, /\.update\(\{\s*is_active:\s*false/);
  assert.doesNotMatch(deleteFunction, /\.delete\(/);
  assert.match(users, /user\.role === 'admin'[\s\S]{0,160}u\.role === 'admin'/);
});
