-- Read-only preflight for migration 0083. Run against the intended database.
BEGIN READ ONLY;

SELECT sale.id, sale.status, sale.customer_id, sale.total_payable,
  sale.total_amount, sale.debt_before_snapshot, sale.debt_after_snapshot,
  sale.cancelled_at, customer.debt AS current_debt,
  ledger.calculated_balance AS ledger_debt
FROM public.orders sale
JOIN public.customers customer ON customer.id = sale.customer_id
LEFT JOIN LATERAL public.p74_customer_debt_ledger_balance(customer.id)
  ledger ON true
WHERE sale.id = 'HD-20261005-00002274';

SELECT debt.id, debt.customer_id, debt.transaction_type,
  debt.debt_change, debt.balance_before, debt.balance_after,
  debt.reversal_of_id, debt.created_at
FROM public.customer_debt_transactions debt
WHERE debt.order_id = 'HD-20261005-00002274'
ORDER BY debt.created_at, debt.id;

ROLLBACK;
