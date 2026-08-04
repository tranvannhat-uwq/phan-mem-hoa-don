import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeOrderItemsForEditing } from '../js/domain/order-edit.js';

test('legacy draft items with an embedded product remain editable', () => {
  const [item] = normalizeOrderItemsForEditing([{
    product: {
      id: 'legacy-product',
      code: 'LEGACY-01',
      name: 'Sơn lót chống kiềm nội thất',
      brand: 'COVA NANO',
      packageType: 'Lon'
    },
    package: 'Lon',
    quantity: 10,
    price: 629000,
    discountPercent: 0
  }], []);

  assert.equal(item.product.name, 'Sơn lót chống kiềm nội thất');
  assert.equal(item.product.code, 'LEGACY-01');
  assert.equal(item.variantId, 'legacy-product');
  assert.equal(item.quantity, 10);
  assert.equal(item.price, 629000);
});

test('snapshot draft items prefer the current matching catalog product without changing money', () => {
  const products = [{ id: 'sku-1', code: 'SKU-01', name: 'Tên hiện tại', brand: 'ABS' }];
  const [item] = normalizeOrderItemsForEditing([{
    variantId: 'sku-1',
    variantCode: 'SKU-01',
    productName: 'Tên snapshot',
    brand: 'ABS',
    packagingName: 'Bộ',
    quantity: 8,
    price: 1110500,
    discountPercent: 5
  }], products);

  assert.equal(item.product.id, products[0].id);
  assert.equal(item.product.name, 'Tên hiện tại');
  assert.equal(item.package, 'Bộ');
  assert.equal(item.quantity, 8);
  assert.equal(item.price, 1110500);
  assert.equal(item.discountPercent, 5);
});

test('incomplete legacy rows receive safe display fallbacks instead of stopping edit', () => {
  const [item] = normalizeOrderItemsForEditing([{ quantity: '2', price: '50000' }], []);
  assert.equal(item.product.name, 'Sản phẩm 1');
  assert.equal(item.product.code, 'LEGACY-1');
  assert.equal(item.quantity, 2);
  assert.equal(item.price, 50000);
});
