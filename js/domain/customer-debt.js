/**
 * Customer debt convention used everywhere in the application:
 *   > 0: customer still owes the company
 *   = 0: settled
 *   < 0: customer has a credit / paid in advance
 *
 * Amounts are rounded to VND so the UI and database ledger cannot drift on
 * fractional arithmetic.
 */
export function toDebtAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.round(amount) : 0;
}

export function getOrderOutstandingAmount(order = {}) {
  const explicitAmountDue = Number(order.amountDue ?? order.debtAmount ?? order.debt_amount);
  if (Number.isFinite(explicitAmountDue)) return Math.max(0, Math.round(explicitAmountDue));

  const totalPayable = toDebtAmount(order.totalPayable ?? order.total_payable ?? order.totalAmount ?? order.total_amount);
  const shippingFee = Math.max(0, toDebtAmount(order.shippingFeeAmount ?? order.shipping_fee_amount ?? order.shippingFeeValue ?? order.shipping_fee_value));
  const paidAmount = Math.max(0, toDebtAmount(order.paidAmount ?? order.paid_amount));
  return Math.max(0, totalPayable + shippingFee - paidAmount);
}

export function chargeCustomerDebt(balanceBefore, amount) {
  return toDebtAmount(balanceBefore) + Math.max(0, toDebtAmount(amount));
}

export function collectCustomerDebt(balanceBefore, amount) {
  return toDebtAmount(balanceBefore) - Math.max(0, toDebtAmount(amount));
}

export function reduceCustomerDebtForReturn(balanceBefore, amount) {
  return collectCustomerDebt(balanceBefore, amount);
}

export function restoreCustomerDebtForCancelledReturn(balanceBefore, amount) {
  return chargeCustomerDebt(balanceBefore, amount);
}

/**
 * Resolve the immutable balance snapshot created when an order was posted.
 * Ledger row ids are not order ids (for example `dtx-ord-...`), so callers
 * must match the dedicated orderId field. The id fallback only supports old
 * browser-cached history entries created before the ledger was authoritative.
 */
export function getOrderDebtSnapshot(order = {}, customer = {}, ledgerSnapshot = null) {
  const orderId = String(order.id || '');
  const history = Array.isArray(customer?.debtHistory) ? customer.debtHistory : [];
  const historyEntry = history.find(entry =>
    String(entry?.orderId || '') === orderId
    && (entry?.transactionType === 'order' || entry?.type === 'charge')
  ) || history.find(entry =>
    String(entry?.id || '') === orderId
    && (entry?.transactionType === 'order' || entry?.type === 'charge')
  );
  const source = ledgerSnapshot || historyEntry;
  if (!source) return null;

  const debtBefore = Number(source.debtBefore ?? source.balance_before);
  const debtAfter = Number(source.debtAfter ?? source.balance_after);
  if (!Number.isFinite(debtBefore) || !Number.isFinite(debtAfter)) return null;
  return { debtBefore: toDebtAmount(debtBefore), debtAfter: toDebtAmount(debtAfter) };
}

/**
 * Return the ids of order-charge rows and their exact cancellation/amendment
 * reversals. They remain in the ledger for audit, but the customer history UI
 * may hide these zero-net pairs by default.
 */
export function getNeutralizedOrderDebtEntryIds(history = []) {
  const entries = Array.isArray(history) ? history : [];
  const byId = new Map(entries
    .filter(entry => entry?.id)
    .map(entry => [String(entry.id), entry]));
  const hiddenIds = new Set();

  for (const reversal of entries) {
    const isOrderReversal = reversal?.transactionType === 'order_cancel' || reversal?.type === 'order_cancel';
    const originalId = reversal?.reversalOfId ?? reversal?.reversal_of_id;
    if (!isOrderReversal || !originalId) continue;

    const original = byId.get(String(originalId));
    const isOrderCharge = original?.transactionType === 'order' || original?.type === 'charge';
    if (!isOrderCharge) continue;

    const originalOrderId = original?.orderId ?? original?.order_id;
    const reversalOrderId = reversal?.orderId ?? reversal?.order_id;
    if (originalOrderId && reversalOrderId && String(originalOrderId) !== String(reversalOrderId)) continue;

    const originalChange = Number(original?.debtChange ?? original?.debt_change);
    const reversalChange = Number(reversal?.debtChange ?? reversal?.debt_change);
    if (!Number.isFinite(originalChange) || !Number.isFinite(reversalChange)) continue;
    if (toDebtAmount(originalChange + reversalChange) !== 0) continue;

    hiddenIds.add(String(original.id));
    hiddenIds.add(String(reversal.id));
  }
  return hiddenIds;
}

/**
 * The database ledger is authoritative. Older browser builds also cached an
 * optimistic order entry whose id was the order id itself. Once the real
 * ledger row arrives, discard that cached twin instead of showing both rows.
 */
export function mergeCustomerDebtHistory(existingHistory = [], ledgerHistory = []) {
  const merged = new Map();

  for (const item of Array.isArray(existingHistory) ? existingHistory : []) {
    const key = String(item?.id || `legacy:${item?.date || ''}:${item?.type || ''}:${item?.amount || 0}`);
    merged.set(key, item);
  }

  for (const item of Array.isArray(ledgerHistory) ? ledgerHistory : []) {
    const orderId = item?.orderId;
    const isOrderCharge = item?.transactionType === 'order' || item?.type === 'charge';
    if (orderId && isOrderCharge) merged.delete(String(orderId));
    const key = String(item?.id || `ledger:${item?.date || ''}:${item?.type || ''}:${item?.amount || 0}`);
    merged.set(key, item);
  }

  return [...merged.values()];
}
