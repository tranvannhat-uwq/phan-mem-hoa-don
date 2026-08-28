const SALES_WORKSPACE_HASH = '#/ban-hang';
const CUSTOMER_CARE_SHEET_STORAGE_KEY = 'sovie_customer_care_sheet_url';

function isSalesWorkspaceRoute() {
  return window.location.hash.toLowerCase().startsWith(SALES_WORKSPACE_HASH);
}

function initPrivateDataLoginShortcut() {
  const accessButton = document.getElementById('care-private-data-access');
  if (!accessButton) return;

  let clickCount = 0;
  let lastClickAt = 0;
  accessButton.addEventListener('click', () => {
    const now = Date.now();
    clickCount = now - lastClickAt > 2500 ? 1 : clickCount + 1;
    lastClickAt = now;

    if (clickCount === 5) {
      clickCount = 0;
      window.location.hash = SALES_WORKSPACE_HASH;
    }
  });
}

function parseGoogleSheetUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    const sheetId = url.pathname.match(/^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1] || '';
    if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || !sheetId) return null;

    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ''));
    const requestedGid = url.searchParams.get('gid') || hashParams.get('gid') || '0';
    const gid = /^\d+$/.test(requestedGid) ? requestedGid : '0';
    const baseUrl = `https://docs.google.com/spreadsheets/d/${sheetId}`;
    return {
      editUrl: `${baseUrl}/edit?gid=${gid}#gid=${gid}`,
      previewUrl: `${baseUrl}/preview?gid=${gid}&rm=minimal&widget=true&headers=false`
    };
  } catch (_) {
    return null;
  }
}

function initCustomerCareSheet() {
  const frame = document.getElementById('care-sheet-frame');
  const refreshButton = document.getElementById('care-sheet-refresh');
  const settingsButton = document.getElementById('care-sheet-settings');
  const openLink = document.getElementById('care-sheet-open');
  const loading = document.getElementById('care-sheet-loading');
  const state = document.getElementById('care-sheet-state');
  const setup = document.getElementById('care-sheet-setup');
  const configForm = document.getElementById('care-sheet-config-form');
  const urlInput = document.getElementById('care-sheet-url');
  const configError = document.getElementById('care-sheet-config-error');
  const cancelButton = document.getElementById('care-sheet-config-cancel');
  if (!frame) return;

  let loadTimer = null;
  let firstFrameLoad = true;
  let currentSheet = null;

  const setState = (message, { error = false } = {}) => {
    state?.classList.toggle('is-error', error);
    if (state) state.innerHTML = `<span></span> ${message}`;
  };

  const showSetup = () => {
    setup?.classList.remove('is-hidden');
    loading?.classList.add('is-hidden');
    setState(currentSheet ? 'Đang dùng bảng đã lưu' : 'Chưa chọn Google Sheet');
    if (refreshButton) refreshButton.disabled = true;
    if (cancelButton) cancelButton.hidden = !currentSheet;
    if (urlInput) urlInput.value = currentSheet?.editUrl || '';
    if (configError) configError.textContent = '';
    window.setTimeout(() => urlInput?.focus(), 0);
  };

  const setLoadingState = () => {
    frame.classList.remove('is-loaded');
    setup?.classList.add('is-hidden');
    loading?.classList.remove('is-hidden');
    setState('Đang kết nối Google Sheet...');
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.setAttribute('aria-busy', 'true');
    }
    window.clearTimeout(loadTimer);
    loadTimer = window.setTimeout(() => {
      setState('Hãy đăng nhập Google nếu bảng chưa hiển thị', { error: true });
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.removeAttribute('aria-busy');
      }
    }, 12000);
  };

  const loadSheet = ({ cacheBust = false } = {}) => {
    if (!currentSheet) {
      showSetup();
      return;
    }
    setLoadingState();
    const url = new URL(currentSheet.previewUrl);
    if (cacheBust) url.searchParams.set('_reload', String(Date.now()));
    frame.src = url.toString();
  };

  const activateSheet = (value, { persist = true } = {}) => {
    const parsed = parseGoogleSheetUrl(value);
    if (!parsed) {
      if (configError) configError.textContent = 'Link không hợp lệ. Hãy dán link bắt đầu bằng https://docs.google.com/spreadsheets/d/...';
      return false;
    }

    currentSheet = parsed;
    frame.dataset.sheetSrc = parsed.previewUrl;
    if (openLink) {
      openLink.href = parsed.editUrl;
      openLink.setAttribute('aria-disabled', 'false');
    }
    if (persist) {
      try {
        localStorage.setItem(CUSTOMER_CARE_SHEET_STORAGE_KEY, parsed.editUrl);
      } catch (_) {
        // The selected sheet remains usable when browser storage is unavailable.
      }
    }
    loadSheet();
    return true;
  };

  frame.addEventListener('load', () => {
    if (!currentSheet) return;
    window.clearTimeout(loadTimer);
    frame.classList.add('is-loaded');
    loading?.classList.add('is-hidden');
    setState('Danh sách khách hàng đã tải');
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.removeAttribute('aria-busy');
    }
    if (firstFrameLoad) {
      firstFrameLoad = false;
      window.requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: 'auto' }));
    }
  });

  refreshButton?.addEventListener('click', () => loadSheet({ cacheBust: true }));
  settingsButton?.addEventListener('click', showSetup);
  openLink?.addEventListener('click', event => {
    if (!currentSheet) {
      event.preventDefault();
      showSetup();
    }
  });
  configForm?.addEventListener('submit', event => {
    event.preventDefault();
    activateSheet(urlInput?.value || '');
  });
  cancelButton?.addEventListener('click', () => {
    if (!currentSheet) return;
    setup?.classList.add('is-hidden');
    setState('Danh sách khách hàng đã tải');
    if (refreshButton) refreshButton.disabled = false;
  });

  let savedSheetUrl = '';
  try {
    savedSheetUrl = localStorage.getItem(CUSTOMER_CARE_SHEET_STORAGE_KEY) || '';
  } catch (_) {
    // First-time setup remains available when browser storage is unavailable.
  }
  if (!savedSheetUrl || !activateSheet(savedSheetUrl, { persist: false })) showSetup();
}

function initSalesWorkspaceRoute() {
  if (isSalesWorkspaceRoute()) return;
  const loginScreen = document.getElementById('login-screen');
  const appLayout = document.getElementById('app-layout');
  loginScreen?.style.setProperty('display', 'none');
  appLayout?.classList.add('auth-hidden');
}

function initCustomerCareLanding() {
  if (!isSalesWorkspaceRoute()) {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    window.scrollTo(0, 0);
    initCustomerCareSheet();
    initPrivateDataLoginShortcut();
    window.setTimeout(() => window.scrollTo(0, 0), 750);
    window.setTimeout(() => window.scrollTo(0, 0), 1800);
  }
  initSalesWorkspaceRoute();
  window.lucide?.createIcons?.();

  const initialSalesRoute = isSalesWorkspaceRoute();
  window.addEventListener('hashchange', () => {
    if (isSalesWorkspaceRoute() !== initialSalesRoute) window.location.reload();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCustomerCareLanding, { once: true });
} else {
  initCustomerCareLanding();
}
