const SALES_WORKSPACE_HASH = '#/ban-hang';

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

function initCustomerCareSheet() {
  const frame = document.getElementById('care-sheet-frame');
  const refreshButton = document.getElementById('care-sheet-refresh');
  const loading = document.getElementById('care-sheet-loading');
  const state = document.getElementById('care-sheet-state');
  if (!frame) return;

  let loadTimer = null;
  let firstFrameLoad = true;

  const setLoadingState = () => {
    frame.classList.remove('is-loaded');
    loading?.classList.remove('is-hidden');
    state?.classList.remove('is-error');
    if (state) state.innerHTML = '<span></span> Đang kết nối Google Sheet...';
    if (refreshButton) {
      refreshButton.disabled = true;
      refreshButton.setAttribute('aria-busy', 'true');
    }
    window.clearTimeout(loadTimer);
    loadTimer = window.setTimeout(() => {
      state?.classList.add('is-error');
      if (state) state.innerHTML = '<span></span> Hãy đăng nhập Google nếu bảng chưa hiển thị';
      if (refreshButton) {
        refreshButton.disabled = false;
        refreshButton.removeAttribute('aria-busy');
      }
    }, 12000);
  };

  const loadSheet = ({ cacheBust = false } = {}) => {
    const source = frame.dataset.sheetSrc || '';
    if (!source) return;
    setLoadingState();
    const url = new URL(source);
    if (cacheBust) url.searchParams.set('_reload', String(Date.now()));
    frame.src = url.toString();
  };

  frame.addEventListener('load', () => {
    window.clearTimeout(loadTimer);
    frame.classList.add('is-loaded');
    loading?.classList.add('is-hidden');
    state?.classList.remove('is-error');
    if (state) state.innerHTML = '<span></span> Khung dữ liệu Google đã tải';
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
  loadSheet();
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
