-- READ-ONLY assessment, not an implementation of data deletion.
-- Run with a trusted database connection, never with an anonymous browser key.
-- No names, document contents, credentials or individual balances are returned.
-- Business queries require the tables/columns from migrations through 0105.
-- The example cutoff is 2026-10-01 00:00:00+07. Change ALL three occurrences
-- before assessing another month. A count below is NOT authorization to delete.
-- A timeout/error requires ROLLBACK before retrying. Do not remove READ ONLY.

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '20s';
SET LOCAL lock_timeout = '2s';
SET LOCAL TIME ZONE 'Asia/Bangkok';

-- 1. Actual allocated database size; this is not a reclaimable-byte estimate.
SELECT current_database() AS database_name,
       pg_database_size(current_database()) AS database_bytes,
       pg_size_pretty(pg_database_size(current_database())) AS database_size,
       current_timestamp AS assessed_at;

-- Includes indexes and TOAST; do not sum partition parents and children twice.
SELECT n.nspname AS schema_name, c.relname AS relation_name,
       c.relkind, c.relispartition,
       pg_table_size(c.oid) AS table_and_toast_bytes,
       pg_indexes_size(c.oid) AS index_bytes,
       pg_total_relation_size(c.oid) AS total_bytes,
       COALESCE(s.n_live_tup, 0) AS estimated_live_rows,
       COALESCE(s.n_dead_tup, 0) AS estimated_dead_rows,
       s.last_autovacuum, s.last_autoanalyze
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind IN ('r', 'm')
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp%'
ORDER BY total_bytes DESC;

-- 2. Actual deployed migration coverage and real FK dependencies.
SELECT version, applied_at FROM public.schema_migrations ORDER BY version;

SELECT source_namespace.nspname AS source_schema,
       source.relname AS source_table, constraint_row.conname,
       target_namespace.nspname AS target_schema,
       target.relname AS target_table,
       pg_get_constraintdef(constraint_row.oid) AS definition
FROM pg_constraint constraint_row
JOIN pg_class source ON source.oid = constraint_row.conrelid
JOIN pg_namespace source_namespace ON source_namespace.oid = source.relnamespace
JOIN pg_class target ON target.oid = constraint_row.confrelid
JOIN pg_namespace target_namespace ON target_namespace.oid = target.relnamespace
WHERE constraint_row.contype = 'f'
  AND (source_namespace.nspname = 'public' OR target_namespace.nspname = 'public')
ORDER BY source_schema, source_table, constraint_row.conname;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       trigger_row.tgname, trigger_row.tgenabled,
       pg_get_triggerdef(trigger_row.oid) AS definition
FROM pg_trigger trigger_row
JOIN pg_class c ON c.oid = trigger_row.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE NOT trigger_row.tgisinternal AND n.nspname = 'public'
ORDER BY c.relname, trigger_row.tgname;

-- Source hashes identify drift without exporting financial literals in functions.
SELECT n.nspname AS schema_name, p.proname,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       p.prosecdef AS security_definer, p.proconfig,
       md5(p.prosrc) AS source_hash
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'private')
  AND (p.proname ~ '(debt|cashbook|receipt|cancel|amend|supplier|audit|maintenance|inventory)')
ORDER BY schema_name, p.proname, arguments;

-- 3. Potential history/snapshot copies. Inspect CONTENTS only in a secure session.
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema IN ('public', 'private')
  AND (data_type IN ('json', 'jsonb', 'bytea')
       OR column_name ~ '(history|snapshot|fingerprint|request|payload|reference|reversal|amends)')
ORDER BY table_schema, table_name, ordinal_position;

-- 4. Current debt invariant, matching migration 0074's posting-order basis.
-- Deleted/inactive customer profiles are deliberately included.
WITH totals AS (
  SELECT customer_id, count(*) AS ledger_count,
         round(COALESCE(sum(debt_change), 0)) AS change_total
  FROM public.customer_debt_transactions GROUP BY customer_id
), first_rows AS (
  SELECT DISTINCT ON (customer_id) customer_id,
         round(COALESCE(balance_before, 0)) AS opening_balance
  FROM public.customer_debt_transactions
  ORDER BY customer_id, COALESCE(created_at, transaction_date), id
)
SELECT (SELECT count(*) FROM public.customers) AS customer_count,
       (SELECT count(*) FROM totals) AS customers_with_ledger,
       (SELECT count(*) FROM public.customers c
        JOIN totals t ON t.customer_id = c.id
        JOIN first_rows f ON f.customer_id = c.id
        WHERE round(COALESCE(c.debt, 0)) IS DISTINCT FROM
              f.opening_balance + t.change_total) AS customer_balance_mismatches,
       (SELECT count(*) FROM public.customer_debt_transactions t
        WHERE t.balance_before IS NULL OR t.balance_after IS NULL
           OR t.debt_change IS NULL
           OR round(t.balance_after) IS DISTINCT FROM
              round(t.balance_before + t.debt_change)) AS invalid_ledger_rows,
       (SELECT count(*) FROM totals t
        LEFT JOIN public.customers c ON c.id = t.customer_id
        WHERE c.id IS NULL) AS orphan_customer_chains;

-- 5. Candidate counts by source dates, for planning ONLY.
-- Source references and posting order must be resolved before choosing ledger rows.
WITH params AS (SELECT timestamptz '2026-10-01 00:00:00+07' AS cutoff)
SELECT 'orders' AS object_name, count(*) AS old_rows
FROM public.orders, params WHERE COALESCE(order_date, created_at) < cutoff
UNION ALL
SELECT 'cashbook_transactions', count(*) FROM public.cashbook_transactions, params
WHERE COALESCE(date, transaction_date) < cutoff
UNION ALL
SELECT 'sales_returns', count(*) FROM public.sales_returns, params
WHERE COALESCE(return_date, created_at) < cutoff
UNION ALL
SELECT 'ledger_business_date_NOT_a_deletion_plan', count(*)
FROM public.customer_debt_transactions, params WHERE transaction_date < cutoff
UNION ALL
SELECT 'order_amendments_by_posting_date_NOT_a_deletion_plan', count(*)
FROM public.order_amendments, params WHERE created_at < cutoff;

-- 6. Backdated/postdated events and links crossing the proposed cutoff.
-- Counts are an initial inventory, not an exhaustive graph-closure proof.
WITH params AS (SELECT timestamptz '2026-10-01 00:00:00+07' AS cutoff),
old_orders AS (
  SELECT id FROM public.orders, params
  WHERE COALESCE(order_date, created_at) < cutoff
), old_cashbook AS (
  SELECT id FROM public.cashbook_transactions, params
  WHERE COALESCE(date, transaction_date) < cutoff
)
SELECT 'ledger_business_and_posting_dates_cross_cutoff' AS check_name, count(*) AS row_count
FROM public.customer_debt_transactions, params
WHERE (transaction_date < cutoff) IS DISTINCT FROM (created_at < cutoff)
UNION ALL
SELECT 'new_payments_link_old_order', count(*) FROM public.payments p, params
WHERE p.created_at >= cutoff AND p.order_id IN (SELECT id FROM old_orders)
UNION ALL
SELECT 'new_cashbook_link_old_order', count(*) FROM public.cashbook_transactions c, params
WHERE COALESCE(c.date, c.transaction_date) >= cutoff
  AND c.order_id IN (SELECT id FROM old_orders)
UNION ALL
SELECT 'new_returns_link_old_order', count(*) FROM public.sales_returns r, params
WHERE COALESCE(r.return_date, r.created_at) >= cutoff
  AND (r.sale_id IN (SELECT id FROM old_orders) OR r.order_id IN (SELECT id FROM old_orders))
UNION ALL
SELECT 'new_amendments_link_old_order', count(*) FROM public.order_amendments a, params
WHERE a.created_at >= cutoff AND a.order_id IN (SELECT id FROM old_orders)
UNION ALL
SELECT 'new_ledger_link_old_cashbook', count(*) FROM public.customer_debt_transactions t, params
WHERE t.created_at >= cutoff AND t.cashbook_transaction_id IN (SELECT id FROM old_cashbook)
UNION ALL
SELECT 'inventory_positions_link_old_order', count(*) FROM public.inventory_order_positions p
WHERE p.order_id IN (SELECT id FROM old_orders)
UNION ALL
SELECT 'inventory_movements_link_old_order', count(*) FROM public.inventory_movements m
WHERE m.order_id IN (SELECT id FROM old_orders)
UNION ALL
SELECT 'inventory_pending_link_old_order', count(*) FROM public.inventory_pending_orders p
WHERE p.order_id IN (SELECT id FROM old_orders);

-- 7. Logs can still contain old documents even when these logs are recent.
WITH params AS (SELECT timestamptz '2026-10-01 00:00:00+07' AS cutoff),
old_orders AS (
  SELECT id FROM public.orders, params WHERE COALESCE(order_date, created_at) < cutoff
)
SELECT 'audit_logs_referencing_old_orders' AS check_name, count(*) AS row_count
FROM public.audit_logs WHERE table_name = 'orders' AND record_id IN (SELECT id FROM old_orders)
UNION ALL
SELECT 'activity_logs_referencing_old_orders', count(*) FROM public.activity_logs
WHERE order_id IN (SELECT id FROM old_orders)
UNION ALL
SELECT 'customer_profiles_with_legacy_debt_history', count(*) FROM public.customers
WHERE debt_history IS NOT NULL AND debt_history <> '[]'::jsonb;

-- READ ONLY, then release the snapshot. No cleanup functions are called here.
ROLLBACK;
