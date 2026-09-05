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

/**
 * The operational cashbook shows only vouchers that still have financial
 * effect. Cancelled sources and their append-only reversal rows remain in the
 * database audit trail but are not separate business vouchers in the UI.
 */
export function isEffectiveCashbookTransaction(transaction = {}) {
  const status = normalizeCashbookText(transaction.status);
  const transactionType = normalizeCashbookText(
    transaction.transactionType ?? transaction.transaction_type
  );
  const id = normalizeCashbookText(transaction.id);
  const isCancelled = status === 'cancelled'
    || status === 'canceled'
    || status.includes('huy')
    || status.includes('cancel');
  const isReversal = Boolean(transaction.reversalOfId || transaction.reversal_of_id)
    || transactionType.includes('reversal')
    || id.startsWith('void-');
  return !isCancelled && !isReversal;
}

/**
 * Detect and purge ghost duplicate receipts created by client temporary code generation.
 * In earlier versions, when creating a customer receipt, a temporary 'TTM...' code was
 * stored locally while the database created the official 'PT-...' voucher.
 * This helper eliminates any ghost 'TTM...' receipt that duplicates an authoritative customer receipt.
 */
export function purgeGhostCustomerReceipts(transactions = []) {
  if (!Array.isArray(transactions) || transactions.length === 0) return [];

  const customerReceipts = transactions.filter(t =>
    Boolean(t && (
      (t.id && String(t.id).startsWith('PT-')) ||
      (t.cloudId && String(t.cloudId).startsWith('PT-')) ||
      t.transactionType === 'customer_payment' ||
      t.debtImpact === true
    ))
  );

  if (customerReceipts.length === 0) return transactions;

  return transactions.filter(t => {
    if (!t || !t.id || !String(t.id).startsWith('TTM')) return true;

    const isGhostDuplicate = customerReceipts.some(cr => {
      if (cr.id === t.id) return false;
      // 1. Direct cloudId link
      if (t.cloudId && (String(t.cloudId) === String(cr.id) || String(t.cloudId) === String(cr.cloudId))) {
        return true;
      }
      // 2. The customer receipt note references this specific TTM voucher code
      const crRawNote = String(cr.note || '');
      if (crRawNote && new RegExp(`\\b${t.id}\\b`, 'i').test(crRawNote)) {
        return true;
      }
      // 3. Same partner, same amount, both are receipts, within a 30-minute window
      const samePartner = normalizeCashbookText(cr.partner) === normalizeCashbookText(t.partner);
      const sameValue = Math.abs(Number(cr.value || 0) - Number(t.value || 0)) < 1;
      const bothReceipts = (cr.type === 'thu' || cr.direction === 'in') && (t.type === 'thu' || t.direction === 'in');
      if (samePartner && sameValue && bothReceipts) {
        const crTime = new Date(cr.date || cr.transactionDate || 0).getTime();
        const tTime = new Date(t.date || t.transactionDate || 0).getTime();
        if (Number.isFinite(crTime) && Number.isFinite(tTime) && Math.abs(crTime - tTime) <= 30 * 60 * 1000) {
          return true;
        }
      }
      return false;
    });

    return !isGhostDuplicate;
  });
}
