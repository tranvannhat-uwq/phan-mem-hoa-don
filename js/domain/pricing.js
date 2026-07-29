export const PRICE_LIST_TYPES = Object.freeze({
  STANDARD: 'standard',
  CUSTOMER_GROUP: 'customer_group',
  CUSTOMER_SPECIFIC: 'customer_specific'
});

export function normalizePriceListType(type, customerId = null) {
  if (type === PRICE_LIST_TYPES.STANDARD || type === 'general') {
    return PRICE_LIST_TYPES.STANDARD;
  }
  if (type === PRICE_LIST_TYPES.CUSTOMER_GROUP || type === 'group') {
    return PRICE_LIST_TYPES.CUSTOMER_GROUP;
  }
  if (type === PRICE_LIST_TYPES.CUSTOMER_SPECIFIC || type === 'customer') {
    return PRICE_LIST_TYPES.CUSTOMER_SPECIFIC;
  }
  return customerId ? PRICE_LIST_TYPES.CUSTOMER_SPECIFIC : PRICE_LIST_TYPES.STANDARD;
}

export function isPriceListActive(priceList, now = new Date()) {
  if (!priceList || priceList.isActive === false) return false;
  const current = now instanceof Date ? now : new Date(now);
  if (priceList.effectiveFrom && new Date(`${priceList.effectiveFrom}T00:00:00`) > current) return false;
  if (priceList.effectiveTo && new Date(`${priceList.effectiveTo}T23:59:59`) < current) return false;
  return true;
}

export function sortPriceLists(priceLists) {
  return [...priceLists].sort((a, b) => {
    const orderDiff = Number(a.displayOrder || 0) - Number(b.displayOrder || 0);
    if (orderDiff !== 0) return orderDiff;
    return String(a.name || '').localeCompare(String(b.name || ''), 'vi');
  });
}

export function getStandardPriceList(priceLists, now = new Date()) {
  return sortPriceLists(
    (priceLists || []).filter(priceList =>
      normalizePriceListType(priceList.type, priceList.customerId) === PRICE_LIST_TYPES.STANDARD &&
      isPriceListActive(priceList, now)
    )
  )[0] || null;
}

export function getApplicablePriceList(customer, priceLists, requestedPriceListId = '', now = new Date()) {
  const activeLists = sortPriceLists((priceLists || []).filter(priceList => isPriceListActive(priceList, now)));

  if (customer) {
    const specific = activeLists.find(priceList =>
      normalizePriceListType(priceList.type, priceList.customerId) === PRICE_LIST_TYPES.CUSTOMER_SPECIFIC &&
      priceList.customerId === customer.id
    );
    if (specific) return { priceList: specific, selectionSource: 'customer_specific' };

    const defaultId = customer.defaultPriceListId || customer.pricelistId;
    const customerDefault = activeLists.find(priceList => priceList.id === defaultId);
    if (customerDefault) return { priceList: customerDefault, selectionSource: 'customer_default' };

    const groupId = customer.customerGroupId || customer.customer_group_id;
    const groupList = activeLists.find(priceList =>
      normalizePriceListType(priceList.type, priceList.customerId) === PRICE_LIST_TYPES.CUSTOMER_GROUP &&
      priceList.customerGroupId === groupId
    );
    if (groupList) return { priceList: groupList, selectionSource: 'customer_group' };
  }

  if (requestedPriceListId) {
    const requested = activeLists.find(priceList => priceList.id === requestedPriceListId);
    if (requested) return { priceList: requested, selectionSource: 'manual_selection' };
  }

  const standard = getStandardPriceList(activeLists, now);
  return {
    priceList: standard,
    selectionSource: standard ? 'standard' : 'missing'
  };
}

function findOverride(priceListItems, priceListId, productId) {
  return (priceListItems || []).find(item =>
    item.priceListId === priceListId &&
    item.productId === productId &&
    item.price !== null &&
    item.price !== undefined &&
    Number.isFinite(Number(item.price))
  ) || null;
}

function directSource(priceList) {
  const type = normalizePriceListType(priceList.type, priceList.customerId);
  if (type === PRICE_LIST_TYPES.CUSTOMER_SPECIFIC) return 'specific';
  if (type === PRICE_LIST_TYPES.CUSTOMER_GROUP) return 'group';
  return 'standard';
}

export function resolvePriceForList({
  productId,
  priceListId,
  priceLists,
  priceListItems,
  now = new Date()
}) {
  const activeLists = (priceLists || []).filter(priceList => isPriceListActive(priceList, now));
  const byId = new Map(activeLists.map(priceList => [priceList.id, priceList]));
  const requested = byId.get(priceListId);
  if (!requested) {
    return { status: 'missing', price: null, priceListId: priceListId || null, source: 'missing' };
  }

  const visited = new Set();
  let current = requested;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const override = findOverride(priceListItems, current.id, productId);
    if (override) {
      const inherited = current.id !== requested.id;
      return {
        status: inherited ? 'inherited' : 'direct',
        price: Number(override.price),
        priceListId: requested.id,
        sourcePriceListId: current.id,
        source: inherited ? 'inherited' : directSource(current)
      };
    }
    current = current.parentPriceListId ? byId.get(current.parentPriceListId) : null;
  }

  const standard = getStandardPriceList(activeLists, now);
  if (standard && !visited.has(standard.id)) {
    const standardItem = findOverride(priceListItems, standard.id, productId);
    if (standardItem) {
      return {
        status: 'inherited',
        price: Number(standardItem.price),
        priceListId: requested.id,
        sourcePriceListId: standard.id,
        source: 'inherited'
      };
    }
  }

  return {
    status: 'missing',
    price: null,
    priceListId: requested.id,
    sourcePriceListId: null,
    source: 'missing'
  };
}

export function resolveCustomerProductPrice({
  productId,
  customer,
  requestedPriceListId,
  priceLists,
  priceListItems,
  now = new Date()
}) {
  const applicable = getApplicablePriceList(customer, priceLists, requestedPriceListId, now);
  if (!applicable.priceList) {
    return {
      status: 'missing',
      price: null,
      priceListId: null,
      priceListName: '',
      source: 'missing',
      selectionSource: applicable.selectionSource
    };
  }

  const resolved = resolvePriceForList({
    productId,
    priceListId: applicable.priceList.id,
    priceLists,
    priceListItems,
    now
  });
  return {
    ...resolved,
    priceListId: applicable.priceList.id,
    priceListName: applicable.priceList.name,
    selectionSource: applicable.selectionSource
  };
}

export function parseVndInteger(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('-')) return -parseVndInteger(raw.slice(1));
  const digits = raw.replace(/\D/g, '');
  return digits ? Number.parseInt(digits, 10) : null;
}
