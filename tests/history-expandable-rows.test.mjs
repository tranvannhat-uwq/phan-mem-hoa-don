import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const history = fs.readFileSync(path.join(root, 'js/components/history.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const tableBranch = history.slice(
  history.indexOf("if (state.historyViewMode === 'details')"),
  history.indexOf('// ---------------------- DẠNG THẺ')
);

test('details table renders one accessible expandable row pair per order', () => {
  assert.match(tableBranch, /class="history-order-row\$\{isExpanded/);
  assert.match(tableBranch, /tabindex="0" role="button" aria-expanded="\$\{isExpanded\}" aria-controls="\$\{detailId\}"/);
  assert.match(tableBranch, /class="history-expanded-row\$\{isExpanded/);
  assert.match(tableBranch, /<td colspan="10">/);
  assert.match(tableBranch, /class="history-row-toggle"/);
  assert.match(tableBranch, /data-lucide="chevron-down"/);
  assert.doesNotMatch(tableBranch.match(/<td class="history-row-toggle-cell"[\s\S]*?<\/td>/)?.[0] || '', /history-(?:print|copy|edit|view|return|cancel|delete)-btn/);
});

test('expanded panel uses real notes, payment fields and existing action handlers', () => {
  assert.match(tableBranch, /placeholder="Nhập ghi chú cho đơn hàng này\.\.\."/);
  assert.match(tableBranch, /escapeHistoryHtml\(order\.notes \|\| ''\)/);
  assert.match(tableBranch, /paymentSummary\.totalGoods/);
  assert.match(tableBranch, /paymentSummary\.invoiceDiscount/);
  assert.match(tableBranch, /paymentSummary\.customerPayable/);
  assert.match(tableBranch, /paymentSummary\.paidAmount/);
  for (const action of ['notes', 'view', 'edit', 'copy', 'print', 'return', 'cancel', 'delete']) {
    assert.match(tableBranch, new RegExp(`history-${action}-btn`));
  }
  assert.match(history, /dbUpdateOrderNotes\(order\.id, nextNotes\.trim\(\)\)/);
  assert.doesNotMatch(tableBranch, /on(?:click|change|input)=/);
});

test('accordion keeps one row open and isolates interactive controls', () => {
  assert.match(history, /let expandedHistoryOrderId = null/);
  assert.match(history, /expandedHistoryOrderId === normalizedId \? null : normalizedId/);
  assert.match(history, /!visibleOrderIds\.has\(String\(expandedHistoryOrderId \|\| ''\)\)/);
  assert.match(history, /\['Enter', ' '\]\.includes\(event\.key\)/);
  assert.match(history, /history-export-checkbox[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(history, /history-expanded-panel button, \.history-expanded-panel textarea/);
});

test('expanded detail has a scoped animated responsive layout', () => {
  assert.match(styles, /\.history-expanded-motion\s*\{[\s\S]*grid-template-rows:\s*0fr[\s\S]*0\.22s/);
  assert.match(styles, /\.history-expanded-row\.is-expanded \.history-expanded-motion\s*\{[\s\S]*grid-template-rows:\s*1fr/);
  assert.match(styles, /\.history-expanded-panel\s*\{[\s\S]*grid-template-columns:[^;]*1\.7fr/);
  assert.match(styles, /@media \(max-width: 1100px\)[\s\S]*\.history-expanded-panel/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.history-expanded-panel[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});
