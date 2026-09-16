import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const users = fs.readFileSync(path.join(root, 'js/components/users.js'), 'utf8');

test('Accounting can use product create, edit and archive actions', () => {
  const accountingRules = users.slice(
    users.indexOf("} else if (role === 'accounting')"),
    users.indexOf("  } else {", users.indexOf("} else if (role === 'accounting')"))
  );

  assert.doesNotMatch(accountingRules, /btn-open-add-product-modal/);
  assert.doesNotMatch(accountingRules, /edit-prod-btn/);
  assert.doesNotMatch(accountingRules, /archive-prod-btn/);
});

test('Sale product mutation actions remain hidden', () => {
  const saleStart = users.indexOf("if (role === 'sale')", users.indexOf("const styleTagId = 'role-based-css-rules'"));
  const saleRules = users.slice(saleStart, users.indexOf("} else if (role === 'accounting')", saleStart));

  assert.match(saleRules, /btn-open-add-product-modal/);
  assert.match(saleRules, /edit-prod-btn/);
  assert.match(saleRules, /archive-prod-btn/);
});
