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
