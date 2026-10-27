export function retentionCutoffDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit'
  }).formatToParts(now).map(part => [part.type, part.value]));
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 2, 1));
  return date.toISOString().slice(0, 10);
}

export function retentionConfirmation(cutoff) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(cutoff)).map(part => [part.type, part.value]));
  return `XOA TRUOC ${parts.day}/${parts.month}/${parts.year}`;
}

const HISTORY_CACHE_PREFIXES = [
  'billing_system_orders', 'billing_system_customers', 'billing_system_cashbook_',
  'billing_system_sales_returns', 'billing_system_suppliers', 'billing_system_purchases',
  'billing_system_purchase_orders', 'billing_system_purchase_receipts',
  'billing_system_goods_receipts', 'billing_system_customer_debt'
];

export function clearRetainedHistoryCaches(storage) {
  if (!storage) return;
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index);
    if (key && HISTORY_CACHE_PREFIXES.some(prefix => key.startsWith(prefix))) storage.removeItem(key);
  }
}

export function openingDebtRow(checkpoint) {
  return {
    id: `RETENTION-OPENING-${checkpoint.customer_id}`, customer_id: checkpoint.customer_id,
    transaction_type: 'opening_balance', amount: 0, debt_change: 0,
    balance_before: Number(checkpoint.debt_opening), balance_after: Number(checkpoint.debt_opening),
    // Business date is the cutoff. Posting sort places this virtual opening
    // before all retained snapshots, including backdated retained documents.
    transaction_date: checkpoint.cutoff, created_at: '0001-01-01T00:00:00.000Z',
    description: 'Số dư chuyển kỳ — chi tiết kỳ trước đã xóa',
    retention_opening: true, payment_carry: Number(checkpoint.payment_carry || 0)
  };
}

export function independentReturnTotal(items) {
  return items.reduce((sum, item) => {
    const quantity = Number(item.quantity);
    const price = Number(item.unitPrice);
    const deduction = Number(item.deductionPercent || 0);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000
      || Math.abs(quantity * 10_000 - Math.round(quantity * 10_000)) > 0.00001
      || !Number.isSafeInteger(price) || price < 0 || price > 1_000_000_000
      || !Number.isFinite(deduction) || deduction < 0 || deduction > 100
      || Math.abs(deduction * 100 - Math.round(deduction * 100)) > 0.00001) {
      throw new Error('Số lượng, đơn giá hoặc khấu trừ không hợp lệ.');
    }
    // Match PostgreSQL numeric half-up rounding. Binary floating point can
    // turn 0.29 * 100 * 50% into 14.499999999999998 and understate one dong.
    const numerator = BigInt(Math.round(quantity * 10000)) * BigInt(price)
      * BigInt(10000 - Math.round(deduction * 100));
    const total = sum + Number((numerator + 50000000n) / 100000000n);
    if (total > 1_000_000_000_000) throw new Error('Giá trị phiếu vượt giới hạn.');
    return total;
  }, 0);
}
