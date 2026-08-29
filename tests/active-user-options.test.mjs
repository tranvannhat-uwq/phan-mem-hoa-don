import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { isActiveUser } from '../js/domain/user-status.js';

const root = path.resolve(import.meta.dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('soft-deleted profiles are unavailable for new employee assignments', () => {
  const users = [
    { id: 'active', isActive: true },
    { id: 'camel-deleted', isActive: false },
    { id: 'snake-deleted', is_active: false }
  ];
  assert.deepEqual(users.filter(isActiveUser).map(user => user.id), ['active']);

  const customers = read('js/components/customers.js');
  const invoice = read('js/components/invoice.js');
  assert.match(customers, /filter\(isActiveUser\)\.map/);
  assert.match(invoice, /filter\(isActiveUser\)\.map/);
});
