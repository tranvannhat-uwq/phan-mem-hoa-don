import { normalizePriceListType, PRICE_LIST_TYPES } from './pricing.js';

export function supportsInvoiceLineDiscount(priceList) {
  if (!priceList) return false;
  const normalizedName = String(priceList.name || '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return normalizePriceListType(priceList.type, priceList.customerId) === PRICE_LIST_TYPES.GENERAL
    || normalizedName.includes('thi truong');
}
