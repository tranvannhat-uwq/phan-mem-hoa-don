-- READ-ONLY audit. This query changes no data.
-- It reports the same class of mismatch found for Tiền Duy.

WITH ordered_ledger AS (
  SELECT
    ledger.*,
    lag(round(ledger.balance_after)) OVER (
      PARTITION BY ledger.customer_id
      ORDER BY ledger.created_at, ledger.id
    ) AS previous_balance_after,
    row_number() OVER (
      PARTITION BY ledger.customer_id
      ORDER BY ledger.created_at, ledger.id
    ) AS opening_rank
  FROM public.customer_debt_transactions ledger
),
ledger_totals AS (
  SELECT customer_id, round(sum(coalesce(debt_change, 0))) AS total_change
  FROM public.customer_debt_transactions
  GROUP BY customer_id
),
ledger_calculated AS (
  SELECT opening.customer_id,
    round(coalesce(opening.balance_before, 0) + coalesce(totals.total_change, 0)) AS calculated_debt
  FROM ordered_ledger opening
  JOIN ledger_totals totals ON totals.customer_id = opening.customer_id
  WHERE opening.opening_rank = 1
),
aggregate_mismatches AS (
  SELECT
    customer.id AS customer_id,
    customer.code AS customer_code,
    customer.name AS customer_name,
    'AGGREGATE_VS_LEDGER_ARITHMETIC' AS issue_type,
    NULL::text AS ledger_id,
    round(coalesce(customer.debt, 0)) AS customer_debt,
    calculated.calculated_debt AS ledger_calculated_debt,
    round(coalesce(customer.debt, 0) - calculated.calculated_debt) AS difference,
    NULL::text AS transaction_type,
    NULL::timestamptz AS created_at,
    'Số dư khách khác số dư mở đầu cộng tổng biến động ledger'::text AS description
  FROM public.customers customer
  JOIN ledger_calculated calculated ON calculated.customer_id = customer.id
  WHERE round(coalesce(customer.debt, 0))
    IS DISTINCT FROM calculated.calculated_debt
),
chain_breaks AS (
  SELECT
    customer.id AS customer_id,
    customer.code AS customer_code,
    customer.name AS customer_name,
    'HISTORICAL_SNAPSHOT_DISCONTINUITY' AS issue_type,
    ledger.id AS ledger_id,
    round(coalesce(ledger.balance_before, 0)) AS customer_debt,
    round(coalesce(ledger.previous_balance_after, 0)) AS latest_ledger_debt,
    round(coalesce(ledger.balance_before, 0) - coalesce(ledger.previous_balance_after, 0)) AS difference,
    ledger.transaction_type,
    ledger.created_at,
    ledger.description
  FROM ordered_ledger ledger
  JOIN public.customers customer ON customer.id = ledger.customer_id
  WHERE ledger.previous_balance_after IS NOT NULL
    AND round(coalesce(ledger.balance_before, 0))
      IS DISTINCT FROM ledger.previous_balance_after
),
opening_adjustments AS (
  SELECT
    customer.id AS customer_id,
    customer.code AS customer_code,
    customer.name AS customer_name,
    'OPENING_BALANCE_ADJUSTMENT' AS issue_type,
    ledger.id AS ledger_id,
    round(coalesce(ledger.balance_before, 0)) AS customer_debt,
    round(coalesce(ledger.balance_after, 0)) AS latest_ledger_debt,
    round(coalesce(ledger.debt_change, 0)) AS difference,
    ledger.transaction_type,
    ledger.created_at,
    ledger.description
  FROM public.customer_debt_transactions ledger
  JOIN public.customers customer ON customer.id = ledger.customer_id
  WHERE ledger.transaction_type = 'adjust'
    AND (
      lower(coalesce(ledger.description, '')) LIKE '%số dư đầu kỳ%'
      OR lower(coalesce(ledger.description, '')) LIKE '%opening%'
    )
)
SELECT * FROM aggregate_mismatches
UNION ALL
SELECT * FROM chain_breaks
UNION ALL
SELECT * FROM opening_adjustments
ORDER BY customer_code, created_at, issue_type;
