import { state } from '../state.js';
import { updateDbStatusUI } from '../utils.js';
import { invalidateDashboardPayloadCache } from '../components/dashboard.js?v=20261005-egress-v2';
import {
  applyBrandRealtimePayload,
  applyCashbookRealtimePayload,
  applyCustomerRealtimePayload,
  applyCustomerDebtRealtimePayload,
  applyOrderRealtimePayload,
  applyPayrollProductGroupRealtimePayload,
  applyPricingRealtimePayload,
  applyProductRealtimePayload,
  applyStartingBalanceRealtimePayload,
  dbFetchCustomerById,
  dbRefreshOrderById,
  dbRefreshSalesReturnById,
  fetchCloudData,
  isCloudActive,
  supabaseClient,
  tableBrandsName,
  tableCashbookTransactionsName,
  tableCustomerDebtTransactionsName,
  tableCustomersName,
  tableDraftOrdersName,
  tableOrdersName,
  tablePayrollProductGroupsName,
  tablePriceListItemsName,
  tablePricelistsName,
  tableProductsName,
  tableSalesReturnItemsName,
  tableSalesReturnsName,
  tableStartingBalancesName
} from './supabase.js?v=20261005-egress-v2';

const REALTIME_DEBOUNCE_MS = 250;
const DASHBOARD_REALTIME_KINDS = new Set(['customer', 'customerFinancial', 'salesReturn', 'salesReturnItem', 'brand']);
const VISIBLE_PANEL_CATCHUP_COOLDOWN_MS = 60_000;
let realtimeChannel = null;
let realtimeClient = null;
let realtimeRender = null;
let realtimeTimer = null;
let realtimeGeneration = 0;
let realtimeStatus = 'CLOSED';
let pendingEvents = [];
let flushInProgress = false;
let onlineHandler = null;
let offlineHandler = null;
let visibilityHandler = null;
let pageShowHandler = null;
let catchupTimer = null;
let nextConnectionGapId = 0;
let activeConnectionGap = null;
let pendingConnectionGap = null;
const lastVisiblePanelCatchups = new Map();
const lastVisiblePanelGapCatchups = new Map();
const visiblePanelCatchupsInFlight = new Map();

function currentRealtimeUserId() {
  return String(state.currentUser?.authUserId || state.currentUser?.id || '');
}

function isRealtimeSessionCurrent(generation, userId) {
  return generation === realtimeGeneration && Boolean(state.currentUser)
    && userId === currentRealtimeUserId();
}

function createConnectionGap() {
  activeConnectionGap = {
    id: ++nextConnectionGapId,
    recovered: false,
    recoveryStarted: false,
    onlineSeen: false
  };
  return activeConnectionGap;
}

function rememberPendingConnectionGap(gap) {
  if (gap && (!pendingConnectionGap || pendingConnectionGap.id <= gap.id)) {
    pendingConnectionGap = gap;
  }
}

function eventRecordId(payload) {
  return payload?.new?.id || payload?.old?.id || '';
}

function queueRealtimeEvent(event) {
  if (!state.currentUser) return;
  pendingEvents.push(event);
  if (realtimeTimer) clearTimeout(realtimeTimer);
  realtimeTimer = setTimeout(() => {
    realtimeTimer = null;
    void flushRealtimeEvents();
  }, REALTIME_DEBOUNCE_MS);
}

async function flushRealtimeEvents() {
  if (flushInProgress || !state.currentUser || pendingEvents.length === 0) return;
  const generation = realtimeGeneration;
  const userId = currentRealtimeUserId();
  flushInProgress = true;
  const batch = pendingEvents;
  pendingEvents = [];

  try {
    const orderChanges = new Map();
    const customerChanges = new Map();
    const salesReturnChanges = new Map();

    batch.forEach(event => {
      if (event.kind === 'order') {
        const id = eventRecordId(event.payload);
        if (id) orderChanges.set(`${event.isDraft ? 'draft' : 'order'}:${id}`, {
          id,
          isDraft: event.isDraft,
          deleted: event.payload.eventType === 'DELETE',
          payload: event.payload
        });
      } else if (event.kind === 'customer') {
        const id = eventRecordId(event.payload);
        if (id) customerChanges.set(String(id), event.payload);
      } else if (event.kind === 'customerFinancial') {
        applyCustomerDebtRealtimePayload(event.payload);
      } else if (event.kind === 'cashbook') {
        applyCashbookRealtimePayload(event.payload);
      } else if (event.kind === 'startingBalances') {
        applyStartingBalanceRealtimePayload(event.payload);
      } else if (event.kind === 'product') {
        applyProductRealtimePayload(event.payload);
      } else if (event.kind === 'payrollProductGroup') {
        applyPayrollProductGroupRealtimePayload(event.payload);
      } else if (event.kind === 'priceList') {
        applyPricingRealtimePayload('priceList', event.payload);
      } else if (event.kind === 'priceListItem') {
        applyPricingRealtimePayload('priceListItem', event.payload);
      } else if (event.kind === 'brand') {
        applyBrandRealtimePayload(event.payload);
      } else if (event.kind === 'salesReturn') {
        const id = eventRecordId(event.payload);
        if (id) salesReturnChanges.set(String(id), event.payload.eventType === 'DELETE');
      } else if (event.kind === 'salesReturnItem') {
        const row = event.payload?.new || event.payload?.old || {};
        const existingReturn = !row.return_id && row.id
          ? (state.salesReturns || []).find(item =>
              (item.items || []).some(returnItem => String(returnItem.id) === String(row.id)))
          : null;
        const returnId = row.return_id || existingReturn?.id;
        if (returnId) salesReturnChanges.set(String(returnId), false);
      }
    });

    await Promise.all([...orderChanges.values()].map(change =>
      applyOrderRealtimePayload(change.payload, { isDraft: change.isDraft })
        ? Promise.resolve(true)
        : dbRefreshOrderById(change.id, change)
    ));

    for (const [customerId, payload] of customerChanges) {
      if (!isRealtimeSessionCurrent(generation, userId)) return;
      if (!applyCustomerRealtimePayload(payload)) {
        await dbFetchCustomerById(customerId);
      }
    }
    for (const [returnId, deleted] of salesReturnChanges) {
      if (!isRealtimeSessionCurrent(generation, userId)) return;
      await dbRefreshSalesReturnById(returnId, { deleted });
    }

    if (isRealtimeSessionCurrent(generation, userId)) {
      // Invalidate once per batch for rows used by the dashboard RPC. Draft and
      // pricing edits leave the aggregates intact and can reuse their cache.
      if (batch.some(event => DASHBOARD_REALTIME_KINDS.has(event.kind)
          || (event.kind === 'order' && !event.isDraft))) invalidateDashboardPayloadCache();
      if (typeof realtimeRender === 'function') realtimeRender();
    }
  } catch (error) {
    console.warn('Realtime scoped refresh failed; data remains unchanged locally:', error);
  } finally {
    flushInProgress = false;
    if (pendingEvents.length > 0 && !realtimeTimer) {
      realtimeTimer = setTimeout(() => {
        realtimeTimer = null;
        void flushRealtimeEvents();
      }, REALTIME_DEBOUNCE_MS);
    }
  }
}

function queueVisiblePanelCatchup({ connectionGap = null } = {}) {
  if (!state.currentUser) return;
  rememberPendingConnectionGap(connectionGap);
  if (document.visibilityState === 'hidden') return;
  if (!pendingConnectionGap && realtimeStatus === 'SUBSCRIBED') return;
  if (catchupTimer) clearTimeout(catchupTimer);
  const generation = realtimeGeneration;
  const userId = currentRealtimeUserId();
  catchupTimer = setTimeout(() => {
    catchupTimer = null;
    if (!isRealtimeSessionCurrent(generation, userId)) return;
    const connectionGap = pendingConnectionGap;
    pendingConnectionGap = null;
    void refreshVisiblePanelFromCloud({ connectionGap });
  }, 350);
}

function refreshVisiblePanelFromCloud({ connectionGap = null } = {}) {
  if (!state.currentUser) return;
  if (document.visibilityState === 'hidden') {
    rememberPendingConnectionGap(connectionGap);
    return;
  }
  if (!connectionGap && realtimeStatus === 'SUBSCRIBED') return;
  const domainsByPanel = {
    'products-panel': ['products', 'payrollProductGroups'],
    'pricelists-panel': ['pricelists'],
    'invoice-panel': ['products', 'customers', 'pricelists'],
    'history-panel': ['orders', 'salesReturns'],
    'customers-panel': ['customers'],
    'so-quy-panel': ['cashbook', 'startingBalances'],
    'reports-panel': ['orders', 'customers', 'salesReturns'],
    'dashboard-panel': ['customers']
  };
  const panel = state.currentTab;
  const domains = domainsByPanel[panel] || [];
  if (domains.length === 0) return;
  const generation = realtimeGeneration;
  const userId = currentRealtimeUserId();
  const catchupKey = JSON.stringify([generation, userId, panel]);
  const coveredGapId = lastVisiblePanelGapCatchups.get(catchupKey) || 0;
  if (connectionGap && coveredGapId >= connectionGap.id) return;
  const inFlight = visiblePanelCatchupsInFlight.get(catchupKey);
  if (inFlight) {
    if (connectionGap && inFlight.gapId !== connectionGap.id) {
      return inFlight.promise.then(() => {
        if (!isRealtimeSessionCurrent(generation, userId)) return;
        return refreshVisiblePanelFromCloud({ connectionGap });
      });
    }
    return inFlight.promise;
  }

  const lastCatchupAt = lastVisiblePanelCatchups.get(catchupKey) || 0;
  if (!connectionGap && Date.now() - lastCatchupAt < VISIBLE_PANEL_CATCHUP_COOLDOWN_MS) return;

  const request = { gapId: connectionGap?.id || null, promise: null };
  request.promise = fetchCloudData({ onlyDomains: domains, hydrateCustomerHistory: false })
    .then(result => {
      if (!isRealtimeSessionCurrent(generation, userId)) return result;
      if (result?.failedDomains?.length) {
        console.warn('Mobile/background catch-up could not load:', result.failedDomains.join(', '));
        rememberPendingConnectionGap(connectionGap);
      } else {
        lastVisiblePanelCatchups.set(catchupKey, Date.now());
        if (connectionGap) lastVisiblePanelGapCatchups.set(catchupKey, connectionGap.id);
      }
      // A connection gap may have missed revenue changes on other tables.
      invalidateDashboardPayloadCache();
      if (typeof realtimeRender === 'function') realtimeRender();
      return result;
    })
    .catch(error => {
      if (!isRealtimeSessionCurrent(generation, userId)) return;
      rememberPendingConnectionGap(connectionGap);
      console.warn('Visible-panel cloud catch-up failed:', error);
    })
    .finally(() => {
      if (visiblePanelCatchupsInFlight.get(catchupKey) === request) {
        visiblePanelCatchupsInFlight.delete(catchupKey);
      }
    });
  visiblePanelCatchupsInFlight.set(catchupKey, request);
  return request.promise;
}

function subscribeTable(channel, table, handler) {
  return channel.on('postgres_changes', { event: '*', schema: 'public', table }, handler);
}

export async function stopRealtimeSync() {
  realtimeGeneration += 1;
  if (realtimeTimer) clearTimeout(realtimeTimer);
  realtimeTimer = null;
  if (catchupTimer) clearTimeout(catchupTimer);
  catchupTimer = null;
  activeConnectionGap = null;
  pendingConnectionGap = null;
  lastVisiblePanelCatchups.clear();
  lastVisiblePanelGapCatchups.clear();
  visiblePanelCatchupsInFlight.clear();
  pendingEvents = [];
  if (onlineHandler) window.removeEventListener('online', onlineHandler);
  if (offlineHandler) window.removeEventListener('offline', offlineHandler);
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
  if (pageShowHandler) window.removeEventListener('pageshow', pageShowHandler);
  onlineHandler = null;
  offlineHandler = null;
  visibilityHandler = null;
  pageShowHandler = null;

  const channel = realtimeChannel;
  const client = realtimeClient;
  realtimeChannel = null;
  realtimeClient = null;
  realtimeRender = null;
  realtimeStatus = 'CLOSED';
  if (channel && client) {
    try {
      await client.removeChannel(channel);
    } catch (error) {
      console.warn('Could not close realtime channel cleanly:', error);
    }
  }
}

export async function startRealtimeSync(renderCallback) {
  if (!isCloudActive || !supabaseClient || !state.currentUser) return false;
  const requestedGeneration = realtimeGeneration + 1;
  await stopRealtimeSync();
  if (realtimeGeneration !== requestedGeneration || !isCloudActive || !supabaseClient || !state.currentUser) {
    return false;
  }

  const generation = realtimeGeneration;
  const userId = currentRealtimeUserId();
  realtimeClient = supabaseClient;
  realtimeRender = renderCallback;
  let channel = realtimeClient.channel(`billing-live-${state.currentUser.authUserId || state.currentUser.id}`);
  let hasEstablishedRealtimeSubscription = false;

  const queueScopedRealtimeEvent = event => {
    if (channel !== realtimeChannel || !isRealtimeSessionCurrent(generation, userId)) return;
    queueRealtimeEvent(event);
  };

  channel = subscribeTable(channel, tableOrdersName,
    payload => queueScopedRealtimeEvent({ kind: 'order', isDraft: false, payload }));
  channel = subscribeTable(channel, tableDraftOrdersName,
    payload => queueScopedRealtimeEvent({ kind: 'order', isDraft: true, payload }));
  channel = subscribeTable(channel, tableCustomersName,
    payload => queueScopedRealtimeEvent({ kind: 'customer', payload }));
  channel = subscribeTable(channel, tableCustomerDebtTransactionsName,
    payload => queueScopedRealtimeEvent({ kind: 'customerFinancial', payload }));
  channel = subscribeTable(channel, tableCashbookTransactionsName,
    payload => queueScopedRealtimeEvent({ kind: 'cashbook', payload }));
  channel = subscribeTable(channel, tableStartingBalancesName,
    payload => queueScopedRealtimeEvent({ kind: 'startingBalances', payload }));
  channel = subscribeTable(channel, tableSalesReturnsName,
    payload => queueScopedRealtimeEvent({ kind: 'salesReturn', payload }));
  channel = subscribeTable(channel, tableSalesReturnItemsName,
    payload => queueScopedRealtimeEvent({ kind: 'salesReturnItem', payload }));
  channel = subscribeTable(channel, tableProductsName,
    payload => queueScopedRealtimeEvent({ kind: 'product', payload }));
  channel = subscribeTable(channel, tablePayrollProductGroupsName,
    payload => queueScopedRealtimeEvent({ kind: 'payrollProductGroup', payload }));
  channel = subscribeTable(channel, tablePricelistsName,
    payload => queueScopedRealtimeEvent({ kind: 'priceList', payload }));
  channel = subscribeTable(channel, tablePriceListItemsName,
    payload => queueScopedRealtimeEvent({ kind: 'priceListItem', payload }));
  channel = subscribeTable(channel, tableBrandsName,
    payload => queueScopedRealtimeEvent({ kind: 'brand', payload }));

  realtimeChannel = channel;
  channel.subscribe(status => {
    if (channel !== realtimeChannel || !isRealtimeSessionCurrent(generation, userId)) return;
    realtimeStatus = status;
    if (status === 'SUBSCRIBED') {
      updateDbStatusUI('cloud', 'Đám mây • Trực tiếp');
      // PostgreSQL Realtime can reconnect after a temporary network loss
      // without replaying rows changed while this client was away. The initial
      // page load is already authoritative; only a later subscription needs a
      // narrow, read-only catch-up for the panel currently on screen.
      if (hasEstablishedRealtimeSubscription) {
        if (!activeConnectionGap || activeConnectionGap.recovered) createConnectionGap();
        activeConnectionGap.recovered = true;
        activeConnectionGap.recoveryStarted = true;
        rememberPendingConnectionGap(activeConnectionGap);
      } else if (activeConnectionGap) {
        activeConnectionGap.recovered = true;
      }
      if (hasEstablishedRealtimeSubscription) queueVisiblePanelCatchup();
      hasEstablishedRealtimeSubscription = true;
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      if (hasEstablishedRealtimeSubscription && (!activeConnectionGap || activeConnectionGap.recovered)) {
        createConnectionGap();
      }
      updateDbStatusUI('connecting', 'Đang nối lại dữ liệu trực tiếp...');
    } else if (status === 'CLOSED' && hasEstablishedRealtimeSubscription) {
      if (!activeConnectionGap || activeConnectionGap.recovered) createConnectionGap();
    }
  });

  onlineHandler = () => {
    if (!isRealtimeSessionCurrent(generation, userId)) return;
    // The browser's online signal and the channel's SUBSCRIBED callback can
    // describe the same outage, even when the first catch-up already finished.
    if (!activeConnectionGap || (activeConnectionGap.recovered && activeConnectionGap.onlineSeen)) {
      createConnectionGap();
    }
    activeConnectionGap.onlineSeen = true;
    activeConnectionGap.recoveryStarted = true;
    queueVisiblePanelCatchup({ connectionGap: activeConnectionGap });
  };
  window.addEventListener('online', onlineHandler);
  offlineHandler = () => {
    if (!isRealtimeSessionCurrent(generation, userId)) return;
    if (!activeConnectionGap || activeConnectionGap.recovered || activeConnectionGap.recoveryStarted) {
      createConnectionGap();
    }
  };
  window.addEventListener('offline', offlineHandler);
  visibilityHandler = () => {
    if (!isRealtimeSessionCurrent(generation, userId)) return;
    if (document.visibilityState === 'visible') queueVisiblePanelCatchup();
  };
  pageShowHandler = () => {
    if (isRealtimeSessionCurrent(generation, userId)) queueVisiblePanelCatchup();
  };
  document.addEventListener('visibilitychange', visibilityHandler);
  window.addEventListener('pageshow', pageShowHandler);
  return true;
}

export function getRealtimeSyncStatus() {
  return realtimeStatus;
}
