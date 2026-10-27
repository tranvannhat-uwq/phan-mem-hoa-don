const FORMAT = 'soviet-retention-encrypted-v1';
const ITERATIONS = 210_000;
const MAX_BYTES = 256 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function base64(bytes) {
  let text = '';
  for (let index = 0; index < bytes.length; index += 32768) {
    text += String.fromCharCode(...bytes.subarray(index, index + 32768));
  }
  return btoa(text);
}
function unbase64(text) {
  if (typeof text !== 'string' || text.length > MAX_BYTES * 1.5 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error('Nội dung bản sao không hợp lệ.');
  }
  return Uint8Array.from(atob(text), character => character.charCodeAt(0));
}
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
}
async function keyFor(passphrase, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function additionalData(header) {
  return encoder.encode(JSON.stringify({ format: header.format, job_id: header.job_id,
    sha256: header.sha256, compression: header.compression }));
}
async function transform(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function encryptRetentionBackup(prepared, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('Mật khẩu bản sao cần ít nhất 12 ký tự.');
  if (typeof prepared.backup_text !== 'string') throw new Error('Máy chủ chưa trả bản sao phục hồi.');
  let bytes = encoder.encode(prepared.backup_text);
  if (bytes.length > MAX_BYTES) throw new Error('Bản sao quá lớn để xử lý trong trình duyệt; cần sao lưu qua quản trị database.');
  if (await sha256Hex(bytes) !== prepared.backup_sha256) throw new Error('Nội dung tải về không khớp mã kiểm tra của máy chủ.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const compression = typeof CompressionStream === 'function' ? 'gzip' : 'none';
  if (compression === 'gzip') bytes = await transform(bytes, new CompressionStream('gzip'));
  const header = { format: FORMAT, job_id: prepared.job_id, sha256: prepared.backup_sha256, compression,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: base64(salt) },
    cipher: { name: 'AES-GCM', iv: base64(iv) } };
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: additionalData(header) },
    await keyFor(passphrase, salt), bytes);
  return JSON.stringify({ ...header, ciphertext: base64(new Uint8Array(encrypted)) });
}

export async function decryptRetentionBackup(text, passphrase, expected = {}) {
  if (typeof text !== 'string' || text.length > MAX_BYTES * 1.5) throw new Error('File sao lưu không hợp lệ hoặc quá lớn.');
  const file = JSON.parse(text);
  if (file.format !== FORMAT || file.kdf?.name !== 'PBKDF2' || file.kdf?.hash !== 'SHA-256'
    || file.kdf?.iterations !== ITERATIONS || file.cipher?.name !== 'AES-GCM'
    || !['gzip', 'none'].includes(file.compression) || !/^[0-9a-f]{64}$/.test(file.sha256 || '')
    || (expected.jobId && file.job_id !== expected.jobId)
    || (expected.sha256 && file.sha256 !== expected.sha256)) {
    throw new Error('File không thuộc bản sao phục hồi của lần dọn này.');
  }
  const salt = unbase64(file.kdf.salt); const iv = unbase64(file.cipher.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error('Thông tin mã hóa không hợp lệ.');
  let bytes;
  try {
    bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: additionalData(file) },
      await keyFor(passphrase, salt), unbase64(file.ciphertext)));
  } catch (_) { throw new Error('Mật khẩu không đúng hoặc file đã bị thay đổi.'); }
  if (file.compression === 'gzip') {
    if (typeof DecompressionStream !== 'function') throw new Error('Trình duyệt chưa hỗ trợ giải nén bản sao.');
    bytes = await transform(bytes, new DecompressionStream('gzip'));
  }
  if (bytes.length > MAX_BYTES || await sha256Hex(bytes) !== file.sha256) throw new Error('File phục hồi không khớp mã kiểm tra.');
  const payload = JSON.parse(decoder.decode(bytes));
  if (payload.format !== 'soviet-retention-recovery-v1' || payload.job_id !== file.job_id
    || !payload.tables || !payload.columns) throw new Error('Cấu trúc bản sao phục hồi không hợp lệ.');
  return { payload, sha256: file.sha256, jobId: file.job_id };
}
