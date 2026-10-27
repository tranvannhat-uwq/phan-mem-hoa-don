import { sha256Hex } from './retention-backup.js';

const MAX_BYTES = 256 * 1024 * 1024;
const encoder = new TextEncoder();
function invalid() { throw new Error('Nội dung tải sao lưu không đầy đủ hoặc không khớp. Hãy thử tải lại.'); }
const integer = value => Number.isSafeInteger(value) && value >= 0;

// Only small RPC responses cross the network. No raw bundle is cached locally.
export async function prepareStagedRetentionBackup(rpc, requestKey, onProgress = () => {}) {
  onProgress('Đang kiểm tra và chốt phạm vi sao lưu…');
  const session = await rpc('rpc_start_retention_backup', { p_request_key: requestKey });
  if (session?.id !== requestKey || !Array.isArray(session.tables) || session.tables.length > 1000
    || new Set(session.tables).size !== session.tables.length) invalid();
  for (let index = 0; index < session.tables.length; index++) {
    const table = session.tables[index];
    if (typeof table !== 'string' || !/^[a-z][a-z0-9_]*$/.test(table)) invalid();
    onProgress(`Đang chuẩn bị dữ liệu ${index + 1}/${session.tables.length}…`);
    if (!session.staged?.[table]) await rpc('rpc_stage_retention_backup_table', { p_id: requestKey, p_table: table });
  }
  onProgress('Đang đối chiếu dữ liệu và mã kiểm tra bản sao…');
  const manifest = await rpc('rpc_finish_retention_backup', { p_id: requestKey });
  if (manifest?.job_id !== requestKey || !/^[0-9a-f]{64}$/.test(manifest.backup_sha256 || '')
    || !Array.isArray(manifest.plan) || manifest.plan.length > 10000 || !manifest.preview) invalid();
  const tables = new Set(session.tables), seen = new Set();
  let expectedBytes = 0;
  for (const piece of manifest.plan) {
    if (Object.hasOwn(piece, 'text')) {
      if (typeof piece.text !== 'string') invalid();
      expectedBytes += encoder.encode(piece.text).length;
    } else {
      if (!tables.has(piece.table) || seen.has(piece.table) || !integer(piece.parts) || piece.parts < 1 || piece.parts > 16384
        || !integer(piece.bytes) || piece.bytes < 2) invalid();
      seen.add(piece.table); expectedBytes += piece.bytes;
    }
    if (expectedBytes > MAX_BYTES) throw new Error('Bản sao vượt 256 MB; cần sao lưu qua quản trị database.');
  }
  if (seen.size !== tables.size) invalid();
  const chunks = [];
  let received = 0;
  for (const piece of manifest.plan) {
    if (Object.hasOwn(piece, 'text')) { chunks.push(piece.text); received += encoder.encode(piece.text).length; continue; }
    let offset = 0, bytes = 0;
    while (offset < piece.parts) {
      onProgress(`Đang tải bản sao ${Math.floor(received * 100 / expectedBytes)}%…`);
      const offsets = [];
      for (let next = offset; next < Math.min(offset + 16, piece.parts); next += 4) offsets.push(next);
      const pages = await Promise.all(offsets.map(next => rpc('rpc_retention_backup_parts', { p_id: requestKey, p_table: piece.table, p_offset: next })));
      for (const page of pages) {
        if (!Array.isArray(page) || page.length < 1 || page.length > 4 || offset + page.length > piece.parts) invalid();
        for (const part of page) {
          if (part.part !== offset || typeof part.text !== 'string') invalid();
          const data = encoder.encode(part.text);
          if (data.length > 262144 || bytes + data.length > piece.bytes || await sha256Hex(data) !== part.sha256) invalid();
          chunks.push(part.text); bytes += data.length; received += data.length; offset++;
        }
      }
    }
    if (bytes !== piece.bytes) invalid();
  }
  if (received !== expectedBytes) invalid();
  const backupText = chunks.join(''); chunks.length = 0;
  onProgress('Đang kiểm tra toàn bộ file trước khi mã hóa…');
  if (await sha256Hex(backupText) !== manifest.backup_sha256) invalid();
  return { job_id: manifest.job_id, backup_text: backupText, backup_sha256: manifest.backup_sha256,
    preview: manifest.preview, expires_at: manifest.expires_at };
}
