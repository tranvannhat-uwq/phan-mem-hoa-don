import { state } from '../state.js';
import { dbPreviewMonthlyRetention, dbPrepareMonthlyRetention, dbExecuteMonthlyRetention, dbRetentionJob } from '../services/supabase.js?v=20261027-return-modal-fix-v1';
import { encryptRetentionBackup, decryptRetentionBackup } from '../services/retention-backup.js';
import { retentionConfirmation } from '../domain/data-retention.js';

const labels = { orders: 'Đơn hàng', drafts: 'Đơn nháp', returns: 'Phiếu trả', cashbook: 'Chứng từ quỹ',
  payments: 'Thanh toán', ledger: 'Bút toán công nợ', purchases: 'Phiếu mua', supplier_payments: 'Thanh toán NCC',
  supplier_ledger: 'Công nợ NCC', legacy_archive: 'Nhật ký lưu trữ cũ', support_history: 'Dòng hàng cấp được giữ lịch sử' };
let prepared = null;
let verified = false;
let busy = false;
let uncertain = false;
let setup = false;
const el = id => document.getElementById(`retention-${id}`);
const admin = () => state.currentUser?.role === 'admin';
function message(text, failed = false) {
  el('status').textContent = text;
  el('status').setAttribute('role', failed ? 'alert' : 'status');
}
function controls() {
  if (!el('execute')) return;
  el('preview').disabled = busy || uncertain;
  el('prepare').disabled = busy || uncertain;
  el('archive').disabled = busy || uncertain || Boolean(prepared);
  el('file').disabled = busy || !prepared || uncertain;
  el('execute').disabled = busy || uncertain || !verified || !prepared
    || el('confirmation').value !== retentionConfirmation(prepared.preview.cutoff);
  el('recover').hidden = !uncertain;
  el('recover').disabled = busy;
  el('restart').disabled = busy || uncertain;
}
function reset() {
  prepared = null; verified = false;
  el('file').value = ''; el('confirmation').value = '';
  el('verification').textContent = 'Chưa kiểm tra file đã tải.';
  controls();
}
function showPreview(preview) {
  const date = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Bangkok' }).format(new Date(preview.cutoff));
  el('boundary').textContent = `Xóa chi tiết trước ${date}. Giữ tháng hiện tại và tháng trước theo giờ Việt Nam.`;
  el('counts').replaceChildren();
  for (const [key, count] of Object.entries(preview.counts || {})) {
    if (!labels[key]) continue;
    const row = document.createElement('li'); row.textContent = `${labels[key]}: ${Number(count).toLocaleString('vi-VN')}`;
    el('counts').append(row);
  }
  const blockers = preview.blockers || [];
  el('blockers').replaceChildren();
  blockers.forEach(text => { const row = document.createElement('li'); row.textContent = text; el('blockers').append(row); });
  if (prepared) el('confirmation-label').textContent = `Nhập chính xác: ${retentionConfirmation(preview.cutoff)}`;
  return blockers.length === 0;
}
async function action(fn) {
  if (busy || !admin()) return;
  busy = true; controls();
  try { await fn(); } catch (error) { message(error.message || 'Không thể thực hiện. Hãy kiểm tra kết nối.', true); }
  finally { busy = false; controls(); }
}
export function renderRetentionSettings() {
  const section = document.getElementById('monthly-retention-section');
  if (section) section.hidden = !admin();
  if (!admin() && setup) reset();
}
export function setupRetentionSettings() {
  if (setup || !el('preview')) return;
  setup = true;
  el('confirmation').addEventListener('input', controls);
  el('restart').addEventListener('click', () => { reset(); message('Đã bỏ lần chuẩn bị. File sao lưu cũ vẫn do bạn quản lý.'); });
  el('preview').addEventListener('click', () => action(async () => {
    reset(); message('Đang kiểm tra công nợ, liên kết và phạm vi xóa…');
    const result = await dbPreviewMonthlyRetention(el('archive').checked);
    message(showPreview(result) ? 'Kiểm tra đạt. Bật bảo trì, đóng các phiên Admin khác rồi tạo bản sao phục hồi.' : 'Chưa thể dọn. Cần xử lý các vấn đề bên dưới.');
  }));
  el('prepare').addEventListener('click', () => action(async () => {
    const passphrase = el('password').value;
    if (passphrase.length < 12 || passphrase !== el('password-again').value) throw new Error('Mật khẩu cần ít nhất 12 ký tự và hai lần nhập phải giống nhau.');
    reset(); message('Đang khóa phạm vi ngắn hạn và tạo bản sao phục hồi…');
    const result = await dbPrepareMonthlyRetention(crypto.randomUUID(), el('archive').checked);
    if (!result.backup_text) throw new Error('Không nhận được nội dung sao lưu; chưa được phép xóa.');
    const encrypted = await encryptRetentionBackup(result, passphrase);
    // Keep only verification metadata in memory. Never cache the raw bundle or password.
    prepared = { job_id: result.job_id, backup_sha256: result.backup_sha256, preview: result.preview, expires_at: result.expires_at };
    result.backup_text = '';
    showPreview(prepared.preview);
    const url = URL.createObjectURL(new Blob([encrypted], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `SoViet-phuc-hoi-${prepared.job_id}.encrypted.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    el('password').value = ''; el('password-again').value = '';
    message('Đã tạo file mã hóa. Chọn lại file vừa tải và nhập mật khẩu để kiểm tra. Lần chuẩn bị hết hạn sau 30 phút; có dữ liệu thay đổi phải làm lại.');
  }));
  el('file').addEventListener('change', () => action(async () => {
    verified = false;
    const file = el('file').files?.[0];
    if (!file || !prepared) return;
    if (file.size > 384 * 1024 * 1024) throw new Error('File quá lớn hoặc không hợp lệ.');
    const password = el('verify-password').value;
    try {
      await decryptRetentionBackup(await file.text(), password, { jobId: prepared.job_id, sha256: prepared.backup_sha256 });
      verified = true; el('verification').textContent = 'Đã giải mã và đối chiếu SHA-256 thành công.';
      message('File phục hồi khớp bản chuẩn bị. Kiểm tra phạm vi và nhập dòng xác nhận để mở nút xóa.');
    } finally { el('verify-password').value = ''; el('file').value = ''; }
  }));
  el('execute').addEventListener('click', () => action(async () => {
    if (!verified || !prepared || uncertain) throw new Error('Phải xác minh lại bản sao phục hồi.');
    if (Date.now() >= Date.parse(prepared.expires_at)) { verified = false; throw new Error('Lần chuẩn bị đã hết hạn. Hãy tạo bản sao mới.'); }
    uncertain = true; message('Đang dọn và đối soát trong một giao dịch. Giữ nguyên màn hình…'); controls();
    try {
      const result = await dbExecuteMonthlyRetention(prepared.job_id, prepared.backup_sha256, el('confirmation').value);
      if (!result.verified) throw new Error('Chưa nhận được kết quả đối soát thành công.');
      uncertain = false; reset();
      message('Đã dọn và đối soát thành công. Đang tải lại ứng dụng…');
      window.location.reload();
    } catch (error) {
      // An HTTP error cannot prove that the transaction was rolled back.
      message(`${error.message || 'Mất phản hồi.'} Bấm “Kiểm tra kết quả” trước khi thao tác tiếp.`, true);
    }
  }));
  el('recover').addEventListener('click', () => action(async () => {
    const job = await dbRetentionJob(prepared.job_id);
    if (!job) throw new Error('Chưa xác minh được lần dọn. Giữ file phục hồi và kiểm tra với quản trị viên.');
    if (job.state === 'completed') { message('Máy chủ xác nhận đã dọn thành công. Đang tải lại…'); window.location.reload(); return; }
    if (job.state !== 'prepared') throw new Error('Máy chủ chưa xác nhận trạng thái cuối. Hãy kiểm tra lại sau.');
    uncertain = false; reset(); message('Lần dọn chưa được ghi nhận hoàn tất. Hãy xem trước và tạo bản sao mới.');
  }));
  controls(); renderRetentionSettings();
}
