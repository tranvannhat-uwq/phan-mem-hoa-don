import assert from 'node:assert/strict';
import {
  PRICE_LIST_TYPES,
  getApplicablePriceList,
  resolvePriceForList,
  resolveCustomerProductPrice,
  filterPriceListsForUser,
  canUserViewPriceList,
  isPrivilegedPricingRole,
  parseVndInteger
} from '../js/domain/pricing.js';

const priceLists = [
  { id: 'standard', name: 'Giá chung', type: PRICE_LIST_TYPES.GENERAL, isActive: true, isAvailableForSales: false, displayOrder: 0 },
  { id: 'sales-a', name: 'Bảng sale A', type: PRICE_LIST_TYPES.SALES, parentPriceListId: 'standard', isActive: true, isAvailableForSales: true, displayOrder: 5 },
  { id: 'bg03', name: 'BG03', type: PRICE_LIST_TYPES.CUSTOMER_GROUP, parentPriceListId: 'standard', isActive: true, isAvailableForSales: false, displayOrder: 10 },
  { id: 'tung-private', name: 'Giá Tùng Quảng Ninh', type: PRICE_LIST_TYPES.DEALER_PRIVATE, customerId: 'tung', parentPriceListId: 'bg03', isActive: true, isAvailableForSales: false, displayOrder: 20 }
];

const standardOnly = [
  { priceListId: 'standard', productId: 'ba46-lon', price: 2116000 }
];

assert.deepEqual(
  resolvePriceForList({
    productId: 'ba46-lon',
    priceListId: 'standard',
    priceLists,
    priceListItems: standardOnly
  }),
  {
    status: 'direct',
    price: 2116000,
    priceListId: 'standard',
    sourcePriceListId: 'standard',
    source: 'standard'
  }
);

const inherited = resolvePriceForList({
  productId: 'ba46-lon',
  priceListId: 'bg03',
  priceLists,
  priceListItems: standardOnly
});
assert.equal(inherited.status, 'inherited');
assert.equal(inherited.price, 2116000);
assert.equal(inherited.sourcePriceListId, 'standard');

const overriddenItems = [
  ...standardOnly,
  { priceListId: 'bg03', productId: 'ba46-lon', price: 1950000 }
];
const overridden = resolvePriceForList({
  productId: 'ba46-lon',
  priceListId: 'bg03',
  priceLists,
  priceListItems: overriddenItems
});
assert.equal(overridden.status, 'direct');
assert.equal(overridden.price, 1950000);
assert.equal(overridden.source, 'group');

const variantPrices = [
  { priceListId: 'bg03', productId: 'ct-d1-lon', price: 390000 },
  { priceListId: 'bg03', productId: 'ct-d1-thung', price: 1180000 }
];
assert.equal(resolvePriceForList({
  productId: 'ct-d1-lon',
  priceListId: 'bg03',
  priceLists,
  priceListItems: variantPrices
}).price, 390000);
assert.equal(resolvePriceForList({
  productId: 'ct-d1-thung',
  priceListId: 'bg03',
  priceLists,
  priceListItems: variantPrices
}).price, 1180000);

const afterDelete = resolvePriceForList({
  productId: 'ba46-lon',
  priceListId: 'bg03',
  priceLists,
  priceListItems: standardOnly
});
assert.equal(afterDelete.status, 'inherited');
assert.equal(afterDelete.price, 2116000);

const customer = { id: 'tung', pricelistId: 'bg03' };
const applicable = getApplicablePriceList(customer, priceLists);
assert.equal(applicable.priceList.id, 'tung-private');
assert.equal(applicable.selectionSource, 'customer_specific');

const privatePrice = resolveCustomerProductPrice({
  productId: 'ba46-lon',
  customer,
  priceLists,
  priceListItems: [
    ...overriddenItems,
    { priceListId: 'tung-private', productId: 'ba46-lon', price: 1900000 }
  ]
});
assert.equal(privatePrice.price, 1900000);
assert.equal(privatePrice.source, 'specific');
assert.equal(privatePrice.priceListId, 'tung-private');

const saleUser = { username: 'sale1', role: 'sale' };
const saleVisible = filterPriceListsForUser(priceLists, saleUser).map(priceList => priceList.id);
assert.deepEqual(saleVisible, ['sales-a']);
assert.equal(isPrivilegedPricingRole(saleUser), false);
assert.equal(isPrivilegedPricingRole({ username: 'admin', role: 'admin' }), true);
assert.equal(isPrivilegedPricingRole({ username: 'accounting', role: 'accounting' }), true);
assert.equal(canUserViewPriceList(saleUser, priceLists.find(priceList => priceList.id === 'tung-private')), false);
assert.equal(canUserViewPriceList({ username: 'admin', role: 'admin' }, priceLists.find(priceList => priceList.id === 'tung-private')), true);

const missing = resolvePriceForList({
  productId: 'new-sku',
  priceListId: 'bg03',
  priceLists,
  priceListItems: standardOnly
});
assert.equal(missing.status, 'missing');
assert.equal(missing.price, null);

assert.equal(parseVndInteger('1.950.000'), 1950000);
assert.equal(parseVndInteger('2,116,000 ₫'), 2116000);
assert.equal(parseVndInteger('-1.000'), -1000);
assert.equal(parseVndInteger(''), null);

console.log('pricing.test.mjs: all assertions passed');
