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

/**
 * Balance snapshots are created in database posting order. A document may
 * carry an older business date, so sorting by that date can make consecutive
 * balanceBefore/balanceAfter values appear contradictory. Posting order is
 * therefore the only order allowed for a running-balance statement.
 */
export function getCustomerDebtPostingDate(entry = {}) {
  return entry.postedAt
    ?? entry.posted_at
    ?? entry.createdAt
    ?? entry.created_at
    ?? entry.date
    ?? entry.transactionDate
    ?? entry.transaction_date
    ?? '';
}

/**
 * Return the original business timestamp shown on the document. This may be
 * older than createdAt/postedAt when an existing invoice is amended today.
 */
export function getCustomerDebtBusinessDate(entry = {}) {
  return entry.date
    ?? entry.transactionDate
    ?? entry.transaction_date
    ?? entry.postedAt
    ?? entry.posted_at
    ?? entry.createdAt
    ?? entry.created_at
    ?? '';
}

export function getOrderOutstandingAmount(order = {}) {
  // `totalPayable` is the invoice amount after its discount.  Some legacy
  // order payloads kept `amountDue` as the pre-discount order total, so never
  // let that compatibility field override an available post-discount total.
  const rawTotalPayable = Number(order.totalPayable ?? order.total_payable);
  const rawTotalAmount = Number(order.totalAmount ?? order.total_amount);
  const shippingFee = Math.max(0, toDebtAmount(order.shippingFeeAmount ?? order.shipping_fee_amount ?? order.shippingFeeValue ?? order.shipping_fee_value));
  const paidAmount = Math.max(0, toDebtAmount(order.paidAmount ?? order.paid_amount));
  if (Number.isFinite(rawTotalPayable)) {
    return Math.max(0, toDebtAmount(rawTotalPayable) + shippingFee - paidAmount);
  }
  // totalAmount already includes shipping, unlike totalPayable.
  if (Number.isFinite(rawTotalAmount)) return Math.max(0, toDebtAmount(rawTotalAmount) - paidAmount);

  const explicitAmountDue = Number(order.debtAmount ?? order.debt_amount ?? order.amountDue);
  return Number.isFinite(explicitAmountDue) ? Math.max(0, Math.round(explicitAmountDue)) : 0;
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

const DEBT_CANCELLATION_TYPES = new Set(['payment_cancel', 'order_cancel', 'return_cancel']);
const DEBT_AMENDMENT_TYPES = new Set([
  'payment_amend', 'payment_relink', 'sale_payment_amend', 'return_amend', 'order_amend'
]);

function debtTransactionType(entry = {}) {
  return String(entry.transactionType ?? entry.transaction_type ?? entry.type ?? '').toLowerCase();
}

function debtRelationValue(entry = {}, camelKey, snakeKey) {
  const value = entry?.[camelKey] ?? entry?.[snakeKey];
  return value == null || value === '' ? '' : String(value);
}

/**
 * Build the effective business history shown to users.
 *
 * The database ledger remains append-only for audit. Cancellation rows remove
 * their whole source document from this projection. Amendments are folded
 * into their source transaction so users see one current row per document.
 */
export function projectEffectiveCustomerDebtHistory(history = []) {
  const entries = (Array.isArray(history) ? history : []).filter(entry =>
    entry && !entry.voidedByAmendmentId && !entry.voided_by_amendment_id
      && !entry.historyCorrectionKey && !entry.history_correction_key);
  const byId = new Map(entries
    .filter(entry => entry.id)
    .map(entry => [String(entry.id), entry]));
  const hiddenIds = new Set();

  for (const cancellation of entries) {
    const type = debtTransactionType(cancellation);
    if (!DEBT_CANCELLATION_TYPES.has(type)) continue;
    if (cancellation.id) hiddenIds.add(String(cancellation.id));

    const originalId = debtRelationValue(cancellation, 'reversalOfId', 'reversal_of_id');
    if (originalId) hiddenIds.add(originalId);

    const cashbookId = debtRelationValue(cancellation, 'cashbookTransactionId', 'cashbook_transaction_id');
    const orderId = debtRelationValue(cancellation, 'orderId', 'order_id');
    const returnId = debtRelationValue(cancellation, 'salesReturnId', 'sales_return_id');
    for (const candidate of entries) {
      const sameDocument = (type === 'payment_cancel' && cashbookId
          && debtRelationValue(candidate, 'cashbookTransactionId', 'cashbook_transaction_id') === cashbookId)
        || (type === 'order_cancel' && orderId
          && debtRelationValue(candidate, 'orderId', 'order_id') === orderId)
        || (type === 'return_cancel' && returnId
          && debtRelationValue(candidate, 'salesReturnId', 'sales_return_id') === returnId);
      if (sameDocument && candidate.id) hiddenIds.add(String(candidate.id));
    }
  }

  const projected = new Map(entries
    .filter(entry => entry.id && !DEBT_AMENDMENT_TYPES.has(debtTransactionType(entry)))
    .map(entry => [String(entry.id), { ...entry }]));
  const amendments = entries
    .filter(entry => DEBT_AMENDMENT_TYPES.has(debtTransactionType(entry)))
    .sort((left, right) => new Date(getCustomerDebtPostingDate(left) || 0) - new Date(getCustomerDebtPostingDate(right) || 0));

  for (const amendment of amendments) {
    const amendmentId = amendment.id ? String(amendment.id) : '';
    const amendmentWasCancelled = amendmentId && hiddenIds.has(amendmentId);
    if (amendmentId) hiddenIds.add(amendmentId);
    if (amendmentWasCancelled) continue;

    const type = debtTransactionType(amendment);
    let targetId = debtRelationValue(amendment, 'amendsLedgerId', 'amends_ledger_id')
      || debtRelationValue(amendment, 'reversalOfId', 'reversal_of_id');
    if (type === 'sale_payment_amend') {
      const orderId = debtRelationValue(amendment, 'orderId', 'order_id');
      const orderEntry = entries.find(entry =>
        debtTransactionType(entry) === 'order'
        && debtRelationValue(entry, 'orderId', 'order_id') === orderId);
      if (orderEntry?.id) targetId = String(orderEntry.id);
    }

    const target = targetId ? projected.get(targetId) : null;
    const targetsVisibleAlias = target && String(target.id) !== targetId
      && !hiddenIds.has(String(target.id));
    if (targetId && hiddenIds.has(targetId) && !targetsVisibleAlias
      && !(type === 'order_amend' && projected.has(targetId))) continue;
    const amendmentChange = toDebtAmount(amendment.debtChange ?? amendment.debt_change);

    if (target) {
      const effectiveChange = toDebtAmount(target.debtChange ?? target.debt_change) + amendmentChange;
      target.debtChange = effectiveChange;
      target.amount = Math.abs(effectiveChange);
      target.debtAfter = toDebtAmount(amendment.debtAfter ?? amendment.balance_after);
      if (type !== 'order_amend') target.date = amendment.date || target.date;
      // A date-only amendment is metadata, not a new financial event. Keep
      // the original posting position so changing the voucher date cannot
      // move an old payment above newer transactions and break the visible
      // running-balance sequence.
      if (type !== 'order_amend' && amendmentChange !== 0) {
        target.postedAt = getCustomerDebtPostingDate(amendment) || getCustomerDebtPostingDate(target);
      }
      // Alias the hidden delta to its visible target so a later amendment can
      // safely reference the immediately preceding amendment row.
      if (amendmentId) projected.set(amendmentId, target);
      if (effectiveChange === 0) hiddenIds.add(targetId);
      continue;
    }

    // A relink into another customer references a ledger row owned by the old
    // customer, so that original is intentionally absent from this history.
    // Present the new customer's effective receipt/return, not an adjustment.
    if (amendmentChange !== 0 && amendmentId) {
      const effectiveType = type === 'return_amend' ? 'return' : (amendmentChange < 0 ? 'payment' : 'charge');
      projected.set(amendmentId, {
        ...amendment,
        type: effectiveType,
        transactionType: effectiveType === 'charge' ? 'order' : effectiveType,
        amount: Math.abs(amendmentChange),
        debtChange: amendmentChange,
        ...(type === 'order_amend' ? {
          postedAt: amendment.date || amendment.transactionDate || amendment.transaction_date
            || getCustomerDebtPostingDate(amendment)
        } : {})
      });
      hiddenIds.delete(amendmentId);
    }
  }

  return entries
    .map(entry => entry.id ? projected.get(String(entry.id)) : entry)
    .filter((entry, index, result) => entry
      && !hiddenIds.has(String(entry.id || ''))
      && result.indexOf(entry) === index);
}

function getCustomerDebtEntryChange(entry = {}) {
  const rawExplicit = entry.debtChange ?? entry.debt_change;
  const explicit = Number(rawExplicit);
  if (rawExplicit != null && rawExplicit !== '' && Number.isFinite(explicit)) return toDebtAmount(explicit);
  const amount = Math.abs(toDebtAmount(entry.amount));
  const type = debtTransactionType(entry);
  if (type === 'payment' || type === 'return') return amount === 0 ? 0 : -amount;
  if (type === 'order' || type === 'charge') return amount;
  return toDebtAmount(entry.amount);
}

/** Total effective receipts, using the same amendment/cancellation projection
 * as the statement. Summing original payment rows ignores later corrections.
 */
export function getCustomerTotalPayments(history = []) {
  const entries = Array.isArray(history) ? history : [];
  const effective = projectEffectiveCustomerDebtHistory(entries);
  const collected = effective
    .filter(entry => debtTransactionType(entry) === 'payment')
    .reduce((sum, entry) => sum + Math.max(0, -getCustomerDebtEntryChange(entry)), 0);
  // Old browser histories recorded cancellations without document lineage.
  // Linked cancellations are already removed by the projection above.
  const legacyCancellations = [
    ...effective.filter(entry => debtTransactionType(entry) === 'adjust'
      && String(entry.notes || entry.note || '').toLowerCase().includes('hủy phiếu thu')),
    ...entries.filter(entry => debtTransactionType(entry) === 'payment_cancel'
      && !entry.voidedByAmendmentId && !entry.voided_by_amendment_id
      && !entry.historyCorrectionKey && !entry.history_correction_key
      && !debtRelationValue(entry, 'reversalOfId', 'reversal_of_id')
      && !debtRelationValue(entry, 'cashbookTransactionId', 'cashbook_transaction_id'))
  ].reduce((sum, entry) => sum + Math.abs(toDebtAmount(entry.amount)), 0);
  return Math.max(0, collected - legacyCancellations);
}

/** Add return document values without changing their posted debt impact.
 * A fully cash-refunded return has no debt ledger row in older databases.
 * Include it as a document with zero debt movement, never as a new charge.
 */
export function withCustomerReturnDocuments(history = [], returns = [], customerId = '') {
  const cancelledIds = new Set((Array.isArray(returns) ? returns : [])
    .filter(document => String(document.customerId ?? document.customer_id ?? '') === String(customerId)
      && ['cancelled', 'canceled'].includes(String(document.status || '').toLowerCase()))
    .map(document => String(document.id)));
  const result = (Array.isArray(history) ? history : [])
    .filter(entry => !cancelledIds.has(String(entry.salesReturnId ?? entry.sales_return_id ?? '')))
    .map(entry => ({ ...entry }));
  for (const document of Array.isArray(returns) ? returns : []) {
    const id = String(document.id || '');
    if (!id || String(document.customerId ?? document.customer_id ?? '') !== String(customerId)) continue;
    if (['cancelled', 'canceled'].includes(String(document.status || '').toLowerCase())) continue;
    const total = Number(document.totalRefund ?? document.total_refund ?? document.totalReturnAmount ?? document.total_return_amount);
    const reduction = Number(document.debtReductionAmount ?? document.debt_reduction_amount);
    const cash = Number(document.refundAmount ?? document.refund_amount);
    if (!Number.isFinite(total) || total < 0) continue;
    const fields = { returnTotalAmount: toDebtAmount(total),
      ...(Number.isFinite(reduction) ? { returnDebtReductionAmount: toDebtAmount(reduction) } : {}),
      ...(Number.isFinite(cash) ? { cashRefundAmount: toDebtAmount(cash) } : {}) };
    const entries = result.filter(entry =>
      String(entry.salesReturnId ?? entry.sales_return_id ?? '') === id
      && debtTransactionType(entry) === 'return');
    if (entries.length) {
      entries.forEach(entry => Object.assign(entry, fields));
    } else if (reduction === 0 && Number.isFinite(cash) && toDebtAmount(cash) === toDebtAmount(total)) {
      const date = document.createdAt || document.created_at || document.returnDate || document.return_date;
      result.push({ id: `return-document:${id}`, type: 'return', transactionType: 'return',
        salesReturnId: id, orderId: document.saleId || document.sale_id || document.orderId || document.order_id,
        customerId, date: document.returnDate || document.return_date || date, postedAt: date,
        amount: 0, debtChange: 0, ...fields,
        note: `Phiếu trả hàng ${id}${document.reason ? `: ${document.reason}` : ''}` });
    }
  }
  return result;
}

/**
 * Create the effective user-facing ledger. Technical cancellations are
 * removed and amendments are folded into their source document. Preserve
 * stored before/after snapshots whenever they form a continuous ledger; only
 * histories without a valid chain are reconstructed to the current balance.
 */
export function buildCustomerDebtDisplayHistory(history = [], currentDebt = 0) {
  const chronological = projectEffectiveCustomerDebtHistory(history)
    .map((entry, index) => ({ ...entry, __displayOrder: index }))
    .sort((left, right) => {
      const postingTimeDelta = new Date(getCustomerDebtPostingDate(left) || 0)
        - new Date(getCustomerDebtPostingDate(right) || 0);
      return postingTimeDelta || left.__displayOrder - right.__displayOrder;
    });

  const hasSnapshot = entry => Number.isFinite(Number(entry.debtBefore))
    && Number.isFinite(Number(entry.debtAfter));

  chronological.forEach(entry => {
    entry.debtChange = getCustomerDebtEntryChange(entry);
    entry.__hasDebtSnapshot = hasSnapshot(entry);
    if (entry.__hasDebtSnapshot) {
      entry.debtBefore = toDebtAmount(entry.debtBefore);
      entry.debtAfter = toDebtAmount(entry.debtAfter);
    }
  });

  const roundedCurrentDebt = toDebtAmount(currentDebt);
  const snapshotsFormContinuousChain = chronological.length > 0
    && chronological.every((entry, index) => {
      if (!entry.__hasDebtSnapshot) return false;
      if (entry.debtAfter !== entry.debtBefore + entry.debtChange) return false;
      if (index > 0 && entry.debtBefore !== chronological[index - 1].debtAfter) return false;
      return true;
    })
    && chronological[chronological.length - 1].debtAfter === roundedCurrentDebt;

  if (!snapshotsFormContinuousChain) {
    // A customer statement must always reconcile to the authoritative current
    // balance. Legacy rows can contain stale before/after snapshots after old
    // imports, amendments or interrupted writes. Keep those immutable rows in
    // the database for audit, but do not repeat their broken arithmetic in the
    // user-facing running balance. Invoice printing uses its own persisted
    // order snapshot and is intentionally unaffected by this projection.
    let balanceAfter = roundedCurrentDebt;
    for (let index = chronological.length - 1; index >= 0; index -= 1) {
      const entry = chronological[index];
      if (entry.__hasDebtSnapshot) {
        entry.sourceDebtBefore = entry.debtBefore;
        entry.sourceDebtAfter = entry.debtAfter;
      }
      entry.debtAfter = balanceAfter;
      entry.debtBefore = balanceAfter - entry.debtChange;
      balanceAfter = entry.debtBefore;
    }

    chronological.forEach(entry => {
      delete entry.__hasDebtSnapshot;
      delete entry.__displayOrder;
    });
    return chronological;
  }

  const firstSnapshotIndex = chronological.findIndex(entry => entry.__hasDebtSnapshot);
  if (firstSnapshotIndex === -1) {
    // Old browser/local rows may have no immutable snapshots at all.
    let balanceAfter = toDebtAmount(currentDebt);
    for (let index = chronological.length - 1; index >= 0; index -= 1) {
      const entry = chronological[index];
      entry.debtAfter = balanceAfter;
      entry.debtBefore = balanceAfter - entry.debtChange;
      balanceAfter = entry.debtBefore;
    }
  } else {
    // Fill only legacy gaps between authoritative snapshots from the nearest
    // known side. Existing snapshots are never shifted by currentDebt.
    for (let index = firstSnapshotIndex - 1; index >= 0; index -= 1) {
      const next = chronological[index + 1];
      const entry = chronological[index];
      entry.debtAfter = next.debtBefore;
      entry.debtBefore = entry.debtAfter - entry.debtChange;
    }
    for (let index = firstSnapshotIndex + 1; index < chronological.length; index += 1) {
      const previous = chronological[index - 1];
      const entry = chronological[index];
      if (entry.__hasDebtSnapshot) continue;
      entry.debtBefore = previous.debtAfter;
      entry.debtAfter = entry.debtBefore + entry.debtChange;
    }
  }

  chronological.forEach(entry => {
    delete entry.__hasDebtSnapshot;
    delete entry.__displayOrder;
  });
  return chronological;
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
    for (const [existingKey, existing] of merged) {
      const sameReturnCancellation = item?.transactionType === 'return_cancel'
        && existing?.transactionType === 'return_cancel'
        && item?.salesReturnId
        && String(item.salesReturnId) === String(existing.salesReturnId)
        && String(existing.id || '').startsWith('return-cancel-');
      if (sameReturnCancellation) merged.delete(existingKey);
      const sameReturnPlaceholder = (item?.transactionType === 'return' || item?.type === 'return')
        && (existing?.transactionType === 'return' || existing?.type === 'return')
        && item?.salesReturnId && String(item.salesReturnId) === String(existing.salesReturnId)
        && String(item.id || '') !== String(existing.id || '')
        && String(existing.id || '').startsWith('return-');
      if (sameReturnPlaceholder) merged.delete(existingKey);
    }
    const key = String(item?.id || `ledger:${item?.date || ''}:${item?.type || ''}:${item?.amount || 0}`);
    merged.set(key, item);
  }

  return [...merged.values()];
}
