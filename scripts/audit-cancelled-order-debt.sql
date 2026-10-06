-- READ ONLY. A cancelled ledger-backed order must leave no order-owned debt
-- with any customer, including customers it was transferred away from.
-- Linked customer receipts are independent and intentionally excluded.
WITH order_ledger AS (
  SELECT
    sale.id AS order_id,
    ledger.customer_id,
    round(sum(COALESCE(ledger.debt_change, 0))) AS residual_debt,
    count(*) FILTER (
      WHERE ledger.transaction_type IN ('order', 'order_amend')
    ) AS charge_rows,
    count(*) FILTER (
      WHERE ledger.transaction_type = 'order_cancel'
    ) AS cancellation_rows
  FROM public.orders sale
  JOIN public.customer_debt_transactions ledger
    ON ledger.order_id = sale.id
  WHERE sale.status IN ('cancelled', 'canceled')
    AND ledger.transaction_type IN (
      'order', 'order_amend', 'return', 'return_cancel', 'order_cancel'
    )
  GROUP BY sale.id, ledger.customer_id
)
SELECT
  audit.order_id,
  customer.code AS customer_code,
  audit.residual_debt,
  audit.charge_rows,
  audit.cancellation_rows
FROM order_ledger audit
LEFT JOIN public.customers customer ON customer.id = audit.customer_id
WHERE audit.charge_rows > 0
  AND audit.residual_debt <> 0
ORDER BY abs(audit.residual_debt) DESC, audit.order_id, customer.code;
