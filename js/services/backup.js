import { state } from '../state.js';
import { showToast } from '../utils.js';
import { 
  supabaseClient, 
  isCloudActive,
  tableProductsName,
  tableCustomersName,
  tableOrdersName,
  tableDraftOrdersName,
  tablePricelistsName,
  tableUsersName,
  tableBrandsName,
  fetchCloudData
} from './supabase.js';

// Xuất file sao lưu Excel (nhiều trang chứa dữ liệu các bảng)
export async function exportBackupToExcel() {
  if (!isCloudActive || !supabaseClient) {
    showToast('Vui lòng kết nối với Supabase trước!', 'warning');
    return;
  }
  
  try {
    showToast('Đang khởi tạo file sao lưu dữ liệu...', 'info');
    
    const [
      { data: products },
      { data: customers },
      { data: orders },
      { data: drafts },
      { data: pricelists },
      { data: users },
      { data: brands }
    ] = await Promise.all([
      supabaseClient.from(tableProductsName).select('*'),
      supabaseClient.from(tableCustomersName).select('*'),
      supabaseClient.from(tableOrdersName).select('*'),
      supabaseClient.from(tableDraftOrdersName).select('*'),
      supabaseClient.from(tablePricelistsName).select('*'),
      supabaseClient.from(tableUsersName).select('*'),
      supabaseClient.from(tableBrandsName).select('*')
    ]);

    const wb = XLSX.utils.book_new();

    const sheets = [
      { name: "San_Pham", data: products || [] },
      { name: "Khach_Hang", data: customers || [] },
      { name: "Don_Hang", data: orders || [] },
      { name: "Don_Hang_Nhap", data: drafts || [] },
      { name: "Bang_Gia", data: pricelists || [] },
      { name: "Nguoi_Dung", data: users || [] },
      { name: "Hang_Son", data: brands || [] }
    ];

    sheets.forEach(sheet => {
      // Chuyển các trường object (như JSONB) thành string để lưu trong Excel
      const processedData = sheet.data.map(row => {
        const newRow = { ...row };
        Object.keys(newRow).forEach(key => {
          if (typeof newRow[key] === 'object' && newRow[key] !== null) {
            newRow[key] = JSON.stringify(newRow[key]);
          }
        });
        return newRow;
      });
      const ws = XLSX.utils.json_to_sheet(processedData);
      XLSX.utils.book_append_sheet(wb, ws, sheet.name);
    });

    const timestamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `weblendon_backup_${timestamp}.xlsx`);
    showToast('Đã xuất và tải xuống file sao lưu Excel thành công!', 'success');
  } catch (err) {
    console.error('Backup export failed:', err);
    showToast('Lỗi khi xuất file sao lưu: ' + err.message, 'danger');
  }
}

// Khôi phục dữ liệu từ file sao lưu Excel tải lên
export async function importBackupFromExcel(file, onCompleteCallback) {
  if (!isCloudActive || !supabaseClient) {
    showToast('Vui lòng kết nối với Supabase trước!', 'warning');
    return;
  }
  
  const restoreMode = document.querySelector('input[name="backup-restore-mode"]:checked').value;
  const confirmMsg = restoreMode === 'overwrite'
    ? 'CẢNH BÁO: Chế độ "Ghi đè" sẽ XÓA SẠCH dữ liệu hiện tại trên Cloud trước khi nạp. Bạn có chắc chắn muốn tiếp tục?'
    : 'Bạn có chắc chắn muốn khôi phục dữ liệu từ file sao lưu này? (Chế độ Gộp thêm)';
    
  if (!confirm(confirmMsg)) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      showToast('Đang phân tích file sao lưu...', 'info');
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      
      const tablesMap = {
        "San_Pham": tableProductsName,
        "Khach_Hang": tableCustomersName,
        "Don_Hang": tableOrdersName,
        "Don_Hang_Nhap": tableDraftOrdersName,
        "Bang_Gia": tablePricelistsName,
        "Nguoi_Dung": tableUsersName,
        "Hang_Son": tableBrandsName
      };

      const parseRow = (row) => {
        const parsed = { ...row };
        Object.keys(parsed).forEach(key => {
          const val = parsed[key];
          if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
            try {
              parsed[key] = JSON.parse(val);
            } catch (e) {
              // giữ nguyên dạng chuỗi nếu parse lỗi
            }
          }
        });
        return parsed;
      };

      for (const sheetName of workbook.SheetNames) {
        const tableName = tablesMap[sheetName];
        if (!tableName) continue;
        
        const worksheet = workbook.Sheets[sheetName];
        const rawRows = XLSX.utils.sheet_to_json(worksheet);
        const rows = rawRows.map(parseRow);

        if (restoreMode === 'overwrite') {
          showToast(`Đang dọn sạch bảng ${sheetName}...`, 'info');
          if (sheetName === "San_Pham") {
            const { error: delErr } = await supabaseClient.from(tableName).delete().neq('code', 'temp_none');
            if (delErr) throw delErr;
          } else if (sheetName === "Hang_Son") {
            const { error: delErr } = await supabaseClient.from(tableName).delete().neq('name', 'temp_none');
            if (delErr) throw delErr;
          } else {
            const { error: delErr } = await supabaseClient.from(tableName).delete().neq('id', 'temp_none');
            if (delErr) throw delErr;
          }
        }

        if (rows.length > 0) {
          showToast(`Đang khôi phục ${rows.length} dòng cho bảng ${sheetName}...`, 'info');
          
          // Gửi dữ liệu theo các lô nhỏ để tránh lỗi vượt quá dung lượng
          const chunkSize = 100;
          for (let i = 0; i < rows.length; i += chunkSize) {
            const chunk = rows.slice(i, i + chunkSize);
            const { error: upsertErr } = await supabaseClient
              .from(tableName)
              .upsert(chunk);
              
            if (upsertErr) throw upsertErr;
          }
        }
      }

      showToast('Khôi phục dữ liệu từ file sao lưu thành công!', 'success');
      
      // Reset giao diện file input
      document.getElementById('backup-file-input').value = '';
      document.getElementById('backup-file-name').innerText = 'Chưa chọn file';
      document.getElementById('btn-restore-backup').style.display = 'none';

      // Đồng bộ lại dữ liệu lên State
      await fetchCloudData();
      
      if (typeof onCompleteCallback === 'function') {
        onCompleteCallback();
      }
    } catch (err) {
      console.error('Restore failed:', err);
      showToast('Lỗi khi khôi phục dữ liệu: ' + err.message, 'danger');
    }
  };
  reader.readAsArrayBuffer(file);
}

// Đăng ký sự kiện nút Sao lưu & Khôi phục dữ liệu
export function setupBackupRestoreListeners(onRestoreComplete) {
  const exportBtn = document.getElementById('btn-export-backup');
  const browseBtn = document.getElementById('btn-browse-backup');
  const fileInput = document.getElementById('backup-file-input');
  const fileNameSpan = document.getElementById('backup-file-name');
  const restoreBtn = document.getElementById('btn-restore-backup');

  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      exportBackupToExcel();
      localStorage.setItem('weblendon_last_backup_date', new Date().toLocaleDateString('vi-VN'));
      const reminderBanner = document.getElementById('backup-reminder-banner');
      if (reminderBanner) reminderBanner.style.display = 'none';
    });
  }

  if (browseBtn && fileInput) {
    browseBtn.addEventListener('click', () => {
      fileInput.click();
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        const file = fileInput.files[0];
        fileNameSpan.innerText = file.name;
        restoreBtn.style.display = 'inline-flex';
      } else {
        fileNameSpan.innerText = 'Chưa chọn file';
        restoreBtn.style.display = 'none';
      }
    });
  }

  if (restoreBtn && fileInput) {
    restoreBtn.addEventListener('click', () => {
      if (fileInput.files.length > 0) {
        importBackupFromExcel(fileInput.files[0], onRestoreComplete);
      }
    });
  }

  // Đăng ký sự kiện cho banner nhắc nhở
  const reminderDownloadBtn = document.getElementById('btn-backup-reminder-download');
  const reminderIgnoreBtn = document.getElementById('btn-backup-reminder-ignore');
  const reminderBanner = document.getElementById('backup-reminder-banner');

  if (reminderDownloadBtn) {
    reminderDownloadBtn.addEventListener('click', async () => {
      await exportBackupToExcel();
      localStorage.setItem('weblendon_last_backup_date', new Date().toLocaleDateString('vi-VN'));
      if (reminderBanner) reminderBanner.style.display = 'none';
      const mandatoryModal = document.getElementById('mandatory-backup-modal');
      if (mandatoryModal) mandatoryModal.style.display = 'none';
    });
  }

  if (reminderIgnoreBtn) {
    reminderIgnoreBtn.addEventListener('click', () => {
      // Bỏ qua lời nhắc banner nhẹ cho ngày hôm nay (nhưng 16h30 vẫn sẽ hiện modal bắt buộc)
      localStorage.setItem('weblendon_banner_ignored_date', new Date().toLocaleDateString('vi-VN'));
      if (reminderBanner) reminderBanner.style.display = 'none';
      showToast('Đã ẩn nhắc nhở sao lưu (16:30 hệ thống sẽ yêu cầu bắt buộc).', 'secondary');
    });
  }

  // Đăng ký sự kiện cho modal bắt buộc sao lưu (16h30)
  const mandatoryDownloadBtn = document.getElementById('btn-mandatory-backup-download');
  const mandatoryModal = document.getElementById('mandatory-backup-modal');

  if (mandatoryDownloadBtn) {
    mandatoryDownloadBtn.addEventListener('click', async () => {
      try {
        mandatoryDownloadBtn.disabled = true;
        mandatoryDownloadBtn.innerHTML = '<i data-lucide="loader-2" class="animate-spin"></i> Đang chuẩn bị bản sao lưu...';
        if (typeof lucide !== 'undefined') lucide.createIcons();
        
        await exportBackupToExcel();
        
        localStorage.setItem('weblendon_last_backup_date', new Date().toLocaleDateString('vi-VN'));
        if (mandatoryModal) mandatoryModal.style.display = 'none';
        showToast('Sao lưu thành công! Đã mở khóa ứng dụng.', 'success');
      } catch (err) {
        showToast('Sao lưu thất bại: ' + err.message, 'danger');
      } finally {
        mandatoryDownloadBtn.disabled = false;
        mandatoryDownloadBtn.innerHTML = '<i data-lucide="download"></i> Tải bản sao lưu & Mở khóa ứng dụng';
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    });
  }

  // Sự kiện trước khi đóng trình duyệt (bật cảnh báo nếu sau 16h30 chưa sao lưu)
  window.addEventListener('beforeunload', (e) => {
    if (state.currentUser && (state.currentUser.role === 'admin' || state.currentUser.role === 'accounting')) {
      const now = new Date();
      const hours = now.getHours();
      const minutes = now.getMinutes();
      const isAfter1630 = hours > 16 || (hours === 16 && minutes >= 30);
      const todayStr = now.toLocaleDateString('vi-VN');
      const lastBackup = localStorage.getItem('weblendon_last_backup_date');
      
      if (isAfter1630 && lastBackup !== todayStr) {
        e.preventDefault();
        e.returnValue = 'Bạn chưa thực hiện sao lưu dữ liệu bắt buộc lúc 16:30! Bạn có chắc chắn muốn thoát?';
        return 'Bạn chưa thực hiện sao lưu dữ liệu bắt buộc lúc 16:30! Bạn có chắc chắn muốn thoát?';
      }
    }
  });

  // Chạy kiểm tra định kỳ mỗi 30 giây để tự động kích hoạt nhắc nhở/modal
  setInterval(checkAndShowBackupReminder, 30000);
}

// Kiểm tra và hiển thị nhắc nhở / modal bắt buộc sao lưu cuối ngày
export function checkAndShowBackupReminder() {
  const banner = document.getElementById('backup-reminder-banner');
  const mandatoryModal = document.getElementById('mandatory-backup-modal');

  // Chỉ hiển thị nhắc nhở cho Admin và Kế toán
  if (!state.currentUser || (state.currentUser.role !== 'admin' && state.currentUser.role !== 'accounting')) {
    if (banner) banner.style.display = 'none';
    if (mandatoryModal) mandatoryModal.style.display = 'none';
    return;
  }

  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const todayStr = now.toLocaleDateString('vi-VN');
  const lastBackup = localStorage.getItem('weblendon_last_backup_date');
  const lastIgnoredBanner = localStorage.getItem('weblendon_banner_ignored_date');

  // Kiểm tra mốc giờ 16:30
  const isAfter1630 = hours > 16 || (hours === 16 && minutes >= 30);

  if (lastBackup === todayStr) {
    // Đã sao lưu hôm nay -> Ẩn tất cả nhắc nhở
    if (banner) banner.style.display = 'none';
    if (mandatoryModal) mandatoryModal.style.display = 'none';
    return;
  }

  if (isAfter1630) {
    // Sau 16h30: Bắt buộc sao lưu (hiển thị modal khóa màn hình, ẩn banner)
    if (banner) banner.style.display = 'none';
    if (mandatoryModal && mandatoryModal.style.display !== 'flex') {
      mandatoryModal.style.display = 'flex';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  } else if (hours >= 16) {
    // Từ 16h00 đến 16h29: Hiện banner nhắc nhở nhẹ nhàng (nếu chưa nhấn ẩn), ẩn modal bắt buộc
    if (mandatoryModal) mandatoryModal.style.display = 'none';
    if (lastIgnoredBanner !== todayStr) {
      if (banner && banner.style.display !== 'flex') {
        banner.style.display = 'flex';
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }
    } else {
      if (banner) banner.style.display = 'none';
    }
  } else {
    // Chưa đến 16h00: Ẩn tất cả
    if (banner) banner.style.display = 'none';
    if (mandatoryModal) mandatoryModal.style.display = 'none';
  }
}
