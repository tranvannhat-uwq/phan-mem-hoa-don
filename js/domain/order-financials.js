const REVENUE_STATUSES = new Set([
  'settled',
  'completed',
  'complete',
  'confirmed',
  'partially_returned',
  'returned'
]);

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value) {
  return Math.max(0, Number(value) || 0);
}

function itemFinancials(item) {
  const quantity = nonNegative(item.quantity);
  const unitPrice = nonNegative(
    numberOrNull(item.unitPrice) ??
    numberOrNull(item.unit_price) ??
    numberOrNull(item.price) ??
    numberOrNull(item.listPrice) ??
    numberOrNull(item.list_price)
  );
  const gross = Math.round(quantity * unitPrice);
  const finalUnitPrice = numberOrNull(item.finalUnitPrice) ?? numberOrNull(item.final_unit_price);
  const storedLineTotal = numberOrNull(item.lineTotal) ?? numberOrNull(item.line_total) ?? numberOrNull(item.subtotal);
  const discountPercent = Math.min(100, nonNegative(item.discountPercent ?? item.discount_percent));

  let afterItemDiscount;
  if (finalUnitPrice !== null) {
    afterItemDiscount = Math.round(quantity * nonNegative(finalUnitPrice));
  } else if (storedLineTotal !== null) {
    afterItemDiscount = Math.round(nonNegative(storedLineTotal));
  } else {
    afterItemDiscount = Math.round(gross * (1 - discountPercent / 100));
  }

  afterItemDiscount = Math.min(gross, afterItemDiscount);
  return {
    gross,
    afterItemDiscount,
    discount: gross - afterItemDiscount
  };
}

function activeReturnAmount(order, salesReturns) {
  const orderId = String(order.id || '');
  const fromReturns = (salesReturns || [])
    .filter(ret => String(ret.saleId || ret.orderId || ret.sale_id || ret.order_id || '') === orderId)
    .filter(ret => {
      const status = String(ret.status || 'completed').toLowerCase();
      return status !== 'cancelled' && status !== 'canceled' && status !== 'draft';
    })
    .reduce((sum, ret) => {
      const stored = numberOrNull(ret.totalRefund) ??
        numberOrNull(ret.totalReturnAmount) ??
        numberOrNull(ret.total_refund) ??
        numberOrNull(ret.total_return_amount);
      if (stored !== null) return sum + nonNegative(stored);
      return sum + (ret.items || []).reduce((itemSum, item) => {
        const subtotal = numberOrNull(item.subtotal);
        if (subtotal !== null) return itemSum + nonNegative(subtotal);
        return itemSum + Math.round(nonNegative(item.quantity) * nonNegative(item.refundPrice ?? item.refund_price));
      }, 0);
    }, 0);

  if (fromReturns > 0) return fromReturns;
  return nonNegative(order.returnedAmount ?? order.returned_amount);
}

export function isOrderIncludedInFinancialSummary(order) {
  if (!order || order.deletedAt || order.deleted_at || order.isDeleted) return false;
  return REVENUE_STATUSES.has(String(order.status || 'settled').toLowerCase());
}

export function getOrderFinancialBreakdown(order, salesReturns = []) {
  const itemTotals = (order.items || []).reduce((totals, item) => {
    const line = itemFinancials(item);
    totals.gross += line.gross;
    totals.afterItemDiscount += line.afterItemDiscount;
    totals.itemDiscount += line.discount;
    return totals;
  }, { gross: 0, afterItemDiscount: 0, itemDiscount: 0 });

  const storedMarket = numberOrNull(order.totalMarket) ?? numberOrNull(order.total_market);
  let totalBeforeDiscount = storedMarket !== null && storedMarket > 0
    ? Math.round(storedMarket)
    : itemTotals.gross;

  const storedProductDiscount = numberOrNull(order.totalDiscount) ?? numberOrNull(order.total_discount);
  let productDiscount = storedProductDiscount !== null && storedProductDiscount > 0
    ? Math.round(storedProductDiscount)
    : itemTotals.itemDiscount;

  const storedSubtotal = numberOrNull(order.subtotal);
  let afterItemDiscount = storedSubtotal !== null && storedSubtotal > 0
    ? Math.round(storedSubtotal)
    : Math.max(0, totalBeforeDiscount - productDiscount);

  if (totalBeforeDiscount <= 0) {
    const storedPayable = numberOrNull(order.totalPayable) ??
      numberOrNull(order.total_payable) ??
      numberOrNull(order.totalAmount) ??
      numberOrNull(order.total_amount);
    const storedInvoiceDiscount = nonNegative(order.discountAmount ?? order.discount_amount);
    totalBeforeDiscount = Math.round(nonNegative(storedPayable) + productDiscount + storedInvoiceDiscount);
    afterItemDiscount = Math.max(0, totalBeforeDiscount - productDiscount);
  }

  productDiscount = Math.min(totalBeforeDiscount, Math.max(0, productDiscount));
  afterItemDiscount = Math.min(
    totalBeforeDiscount,
    Math.max(0, afterItemDiscount || (totalBeforeDiscount - productDiscount))
  );

  const storedInvoiceDiscount = numberOrNull(order.discountAmount) ?? numberOrNull(order.discount_amount);
  const discountValue = nonNegative(order.discountValue ?? order.discount_value);
  const discountType = String(order.discountType ?? order.discount_type ?? 'amount').toLowerCase();
  let invoiceDiscount = storedInvoiceDiscount !== null && storedInvoiceDiscount > 0
    ? Math.round(storedInvoiceDiscount)
    : 0;

  if (invoiceDiscount === 0 && discountValue > 0) {
    invoiceDiscount = discountType === 'percent'
      ? Math.round(afterItemDiscount * discountValue / 100)
      : Math.round(discountValue);
  }

  if (invoiceDiscount === 0) {
    const storedPayable = numberOrNull(order.totalPayable) ??
      numberOrNull(order.total_payable) ??
      numberOrNull(order.totalAmount) ??
      numberOrNull(order.total_amount);
    if (storedPayable !== null && storedPayable > 0 && afterItemDiscount >= storedPayable) {
      invoiceDiscount = Math.round(afterItemDiscount - storedPayable);
    }
  }

  invoiceDiscount = Math.min(afterItemDiscount, Math.max(0, invoiceDiscount));
  let totalDiscountAmount = productDiscount + invoiceDiscount;
  let totalAfterDiscount = Math.max(0, totalBeforeDiscount - totalDiscountAmount);

  const returnedAmount = Math.min(totalAfterDiscount, Math.round(activeReturnAmount(order, salesReturns)));
  if (returnedAmount > 0) {
    const remainingAfterDiscount = totalAfterDiscount - returnedAmount;
    const remainingRatio = totalAfterDiscount > 0 ? remainingAfterDiscount / totalAfterDiscount : 0;
    totalBeforeDiscount = Math.round(totalBeforeDiscount * remainingRatio);
    totalAfterDiscount = remainingAfterDiscount;
    totalDiscountAmount = Math.max(0, totalBeforeDiscount - totalAfterDiscount);
  }

  if (String(order.status || '').toLowerCase() === 'returned' && totalAfterDiscount > 0 && returnedAmount === 0) {
    totalBeforeDiscount = 0;
    totalDiscountAmount = 0;
    totalAfterDiscount = 0;
  }

  return {
    totalBeforeDiscount,
    totalDiscountAmount,
    totalAfterDiscount,
    returnedAmount,
    isRevenueEligible: isOrderIncludedInFinancialSummary(order)
  };
}
