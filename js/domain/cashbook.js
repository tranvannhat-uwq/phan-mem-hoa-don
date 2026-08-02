function normalizeCashbookText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .trim()
    .toLowerCase();
}

/** Customer debt receipts require the atomic debt-reversal RPC. */
export function isCustomerDebtReceipt(transaction = {}) {
  const transactionType = normalizeCashbookText(
    transaction.transactionType ?? transaction.transaction_type
  );

  if (transactionType === 'customer_payment') return true;
  if (transactionType) return false;

  const direction = normalizeCashbookText(transaction.type ?? transaction.direction);
  const isReceipt = direction === 'thu' || direction === 'in';
  if (!isReceipt) return false;
  if (transaction.debtImpact === true || transaction.debt_impact === true) return true;

  // Compatibility for rows cached before transactionType was retained.
  return normalizeCashbookText(transaction.category) === 'thu no khach hang';
}

export function getCanonicalCashbookId(transaction = {}) {
  return transaction.cloudId || transaction.cloud_id || transaction.id || '';
}
