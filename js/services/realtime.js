import { state } from '../state.js';
import { updateDbStatusUI } from '../utils.js';
import {
  dbFetchCustomerById,
  dbRefreshCustomerFinancialState,
  dbRefreshOrderById,
  fetchCloudData,
  isCloudActive,
  supabaseClient,
  tableBrandsName,
  tableCashbookTransactionsName,
  tableCustomerDebtTransactionsName,
  tableCustomersName,
  tableDraftOrdersName,
  tableOrdersName,
  tablePriceListItemsName,
  tablePricelistsName,
  tableProductsName,
  tableSalesReturnItemsName,
  tableSalesReturnsName,
  tableStartingBalancesName
} from './supabase.js?v=20260810-sale-pricing1';

const REALTIME_DEBOUNCE_MS = 250;
let realtimeChannel = null;
let realtimeClient = null;
let realtimeRender = null;
let realtimeTimer = null;
let realtimeGeneration = 0;
let realtimeStatus = 'CLOSED';
let pendingEvents = [];
let flushInProgress = false;
let visibilityHandler = null;
let onlineHandler = null;

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
  flushInProgress = true;
  const batch = pendingEvents;
  pendingEvents = [];

  try {
    const orderChanges = new Map();
    const customerChanges = new Map();
    const financialCustomerIds = new Set();
    const refreshDomains = new Set();

    batch.forEach(event => {
      if (event.kind === 'order') {
        const id = eventRecordId(event.payload);
        if (id) orderChanges.set(`${event.isDraft ? 'draft' : 'order'}:${id}`, {
          id,
          isDraft: event.isDraft,
          deleted: event.payload.eventType === 'DELETE'
        });
      } else if (event.kind === 'customer') {
        const id = eventRecordId(event.payload);
        if (id) customerChanges.set(String(id), event.payload.eventType);
      } else if (event.kind === 'customerFinancial') {
        const id = event.payload?.new?.customer_id || event.payload?.old?.customer_id;
        if (id) financialCustomerIds.add(String(id));
      } else if (event.domain) {
        refreshDomains.add(event.domain);
      }
    });

    await Promise.all([...orderChanges.values()].map(change => dbRefreshOrderById(change.id, change)));

    for (const [customerId, eventType] of customerChanges) {
      if (eventType === 'DELETE') {
        state.customers = (state.customers || []).filter(customer => String(customer.id) !== customerId);
        localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      } else {
        await dbFetchCustomerById(customerId);
      }
    }
    for (const customerId of financialCustomerIds) {
      await dbRefreshCustomerFinancialState(customerId);
    }

    if (refreshDomains.size > 0) {
      await fetchCloudData({
        onlyDomains: [...refreshDomains],
        hydrateCustomerHistory: false
      });
    }

    if (typeof realtimeRender === 'function' && state.currentUser) realtimeRender();
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

function queueVisiblePanelCatchup() {
  if (!state.currentUser || document.visibilityState === 'hidden') return;
  const domainsByPanel = {
    'products-panel': ['products'],
    'pricelists-panel': ['pricelists'],
    'invoice-panel': ['products', 'customers', 'pricelists'],
    'history-panel': ['orders', 'salesReturns'],
    'customers-panel': ['customers'],
    'so-quy-panel': ['cashbook', 'startingBalances'],
    'reports-panel': ['orders', 'customers', 'salesReturns'],
    'dashboard-panel': ['orders', 'customers', 'salesReturns']
  };
  (domainsByPanel[state.currentTab] || []).forEach(domain => queueRealtimeEvent({ domain }));
}

function subscribeTable(channel, table, handler) {
  return channel.on('postgres_changes', { event: '*', schema: 'public', table }, handler);
}

export async function stopRealtimeSync() {
  realtimeGeneration += 1;
  if (realtimeTimer) clearTimeout(realtimeTimer);
  realtimeTimer = null;
  pendingEvents = [];
  if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
  if (onlineHandler) window.removeEventListener('online', onlineHandler);
  visibilityHandler = null;
  onlineHandler = null;

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
  await stopRealtimeSync();

  const generation = realtimeGeneration;
  realtimeClient = supabaseClient;
  realtimeRender = renderCallback;
  let channel = realtimeClient.channel(`billing-live-${state.currentUser.authUserId || state.currentUser.id}`);

  channel = subscribeTable(channel, tableOrdersName,
    payload => queueRealtimeEvent({ kind: 'order', isDraft: false, payload }));
  channel = subscribeTable(channel, tableDraftOrdersName,
    payload => queueRealtimeEvent({ kind: 'order', isDraft: true, payload }));
  channel = subscribeTable(channel, tableCustomersName,
    payload => queueRealtimeEvent({ kind: 'customer', payload }));
  channel = subscribeTable(channel, tableCustomerDebtTransactionsName,
    payload => queueRealtimeEvent({ kind: 'customerFinancial', payload }));
  channel = subscribeTable(channel, tableCashbookTransactionsName,
    () => queueRealtimeEvent({ domain: 'cashbook' }));
  channel = subscribeTable(channel, tableStartingBalancesName,
    () => queueRealtimeEvent({ domain: 'startingBalances' }));
  channel = subscribeTable(channel, tableSalesReturnsName,
    () => queueRealtimeEvent({ domain: 'salesReturns' }));
  channel = subscribeTable(channel, tableSalesReturnItemsName,
    () => queueRealtimeEvent({ domain: 'salesReturns' }));
  channel = subscribeTable(channel, tableProductsName,
    () => queueRealtimeEvent({ domain: 'products' }));
  channel = subscribeTable(channel, tablePricelistsName,
    () => queueRealtimeEvent({ domain: 'pricelists' }));
  channel = subscribeTable(channel, tablePriceListItemsName,
    () => queueRealtimeEvent({ domain: 'pricelists' }));
  channel = subscribeTable(channel, tableBrandsName,
    () => queueRealtimeEvent({ domain: 'brands' }));

  realtimeChannel = channel;
  channel.subscribe(status => {
    if (generation !== realtimeGeneration || channel !== realtimeChannel) return;
    realtimeStatus = status;
    if (status === 'SUBSCRIBED') {
      updateDbStatusUI('cloud', 'Đám mây • Trực tiếp');
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      updateDbStatusUI('connecting', 'Đang nối lại dữ liệu trực tiếp...');
    }
  });

  visibilityHandler = () => {
    if (document.visibilityState === 'visible') queueVisiblePanelCatchup();
  };
  onlineHandler = queueVisiblePanelCatchup;
  document.addEventListener('visibilitychange', visibilityHandler);
  window.addEventListener('online', onlineHandler);
  return true;
}

export function getRealtimeSyncStatus() {
  return realtimeStatus;
}
