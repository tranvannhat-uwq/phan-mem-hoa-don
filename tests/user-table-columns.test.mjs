import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('user table header and rendered rows keep the same six-column structure', () => {
  const html = read('index.html');
  const users = read('js/components/users.js');
  const panelStart = html.indexOf('<section id="users-panel"');
  const panelEnd = html.indexOf('<section id="activity-log-panel"', panelStart);
  const panel = html.slice(panelStart, panelEnd);
  const renderStart = users.indexOf('export function renderUsersTable');
  const renderEnd = users.indexOf('export function openUserModal', renderStart);
  const render = users.slice(renderStart, renderEnd);

  assert.match(panel, /<th>Công ty trực thuộc<\/th>/);
  assert.equal((panel.match(/<col\b/g) || []).length, 6);
  assert.equal((panel.match(/<th\b/g) || []).length, 6);
  assert.equal((render.match(/<td\b/g) || []).length, 7);
  assert.match(render, /colspan="6"/);
  assert.match(render, /\$\{compName\}/);
});
