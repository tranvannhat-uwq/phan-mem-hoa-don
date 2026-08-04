import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('backup reminder lives in the top header and the blocking modal is removed', () => {
  const html = read('index.html');
  const topHeaderStart = html.indexOf('<header class="top-header">');
  const topHeaderEnd = html.indexOf('</header>', topHeaderStart);
  const reminder = html.indexOf('id="backup-reminder-banner"');

  assert.ok(topHeaderStart >= 0 && reminder > topHeaderStart && reminder < topHeaderEnd);
  assert.doesNotMatch(html, /mandatory-backup-modal|btn-mandatory-backup-download/);
  assert.doesNotMatch(html, /YÊU CẦU SAO LƯU BẮT BUỘC|Mở khóa ứng dụng/);
});

test('after 16:30 backup is a red blinking non-blocking nav alert', () => {
  const backup = read('js/services/backup.js');
  const css = read('style.css');

  assert.match(backup, /if \(isAfter1630\)[\s\S]*banner\.classList\.add\('is-urgent'\)[\s\S]*banner\.style\.display = 'flex'/);
  assert.doesNotMatch(backup, /mandatory-backup-modal|btn-mandatory-backup-download/);
  assert.doesNotMatch(backup, /beforeunload/);
  assert.match(css, /\.backup-nav-alert\.is-urgent[\s\S]*background: #dc2626/);
  assert.match(css, /animation: backupAlertPulse/);
  assert.match(css, /@keyframes backupAlertPulse/);
});
