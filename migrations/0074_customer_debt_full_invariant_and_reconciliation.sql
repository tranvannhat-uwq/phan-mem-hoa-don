BEGIN;

-- Customer debt has two representations: the append-only business ledger and
-- customers.debt, a cached aggregate used by the application. Every financial
-- RPC locks the customer row, writes both representations in one transaction,
-- and this migration verifies the final state at commit. The older p71 guard
-- covered only order rows, leaving receipts, returns and cancellations able to
-- commit an aggregate mismatch unnoticed.

CREATE OR REPLACE FUNCTION public.p74_customer_debt_ledger_balance(
  p_customer_id text
) RETURNS TABLE(
  ledger_count bigint,
  opening_balance numeric,
  debt_change_total numeric,
  calculated_balance numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH ledger_summary AS (
    SELECT
      count(*) AS ledger_count,
      round(COALESCE(sum(ledger.debt_change), 0)) AS debt_change_total
    FROM public.customer_debt_transactions ledger
    WHERE ledger.customer_id = p_customer_id
  ), opening AS (
    SELECT round(COALESCE(ledger.balance_before, 0)) AS opening_balance
    FROM public.customer_debt_transactions ledger
    WHERE ledger.customer_id = p_customer_id
    ORDER BY COALESCE(ledger.created_at, ledger.transaction_date), ledger.id
    LIMIT 1
  )
  SELECT
    summary.ledger_count,
    opening.opening_balance,
    summary.debt_change_total,
    CASE WHEN summary.ledger_count = 0 THEN NULL
      ELSE opening.opening_balance + summary.debt_change_total END
  FROM ledger_summary summary
  LEFT JOIN opening ON true
$$;

CREATE OR REPLACE FUNCTION public.p74_guard_customer_debt_invariant()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_customer_id text;
  customer_balance numeric;
  ledger_state record;
BEGIN
  IF TG_TABLE_NAME = 'customer_debt_transactions' THEN
    target_customer_id := NEW.customer_id;
    IF NEW.balance_before IS NULL
       OR NEW.debt_change IS NULL
       OR NEW.balance_after IS NULL
       OR round(NEW.balance_after) IS DISTINCT FROM
          round(NEW.balance_before + NEW.debt_change) THEN
      RAISE EXCEPTION
        'Customer debt ledger row % is internally inconsistent: before=% change=% after=%.',
        NEW.id, NEW.balance_before, NEW.debt_change, NEW.balance_after
        USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF OLD.debt IS NOT DISTINCT FROM NEW.debt THEN
      RETURN NEW;
    END IF;
    target_customer_id := NEW.id;
  END IF;

  IF target_customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT round(COALESCE(customer.debt, 0))
  INTO STRICT customer_balance
  FROM public.customers customer
  WHERE customer.id = target_customer_id;

  SELECT * INTO STRICT ledger_state
  FROM public.p74_customer_debt_ledger_balance(target_customer_id);

  -- A legacy profile may have an opening balance but no ledger yet. Once the
  -- first ledger row exists, its opening balance plus every immutable delta is
  -- the only allowed aggregate.
  IF ledger_state.ledger_count > 0
     AND customer_balance IS DISTINCT FROM ledger_state.calculated_balance THEN
    RAISE EXCEPTION
      'Customer debt chain mismatch for %: customers.debt=% but ledger arithmetic yields %.',
      target_customer_id, customer_balance, ledger_state.calculated_balance
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p71_guard_customer_debt_chain_before_order
  ON public.customer_debt_transactions;
DROP TRIGGER IF EXISTS p74_guard_customer_debt_ledger
  ON public.customer_debt_transactions;
CREATE CONSTRAINT TRIGGER p74_guard_customer_debt_ledger
AFTER INSERT OR UPDATE ON public.customer_debt_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.p74_guard_customer_debt_invariant();

DROP TRIGGER IF EXISTS p74_guard_customer_debt_aggregate
  ON public.customers;
CREATE CONSTRAINT TRIGGER p74_guard_customer_debt_aggregate
AFTER UPDATE ON public.customers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (OLD.debt IS DISTINCT FROM NEW.debt)
EXECUTE FUNCTION public.p74_guard_customer_debt_invariant();

-- Repair only the cached aggregate. This never edits, deletes or fabricates a
-- business ledger row. It is intentionally role-scoped and audited so other
-- mismatches can be reviewed and reconciled without a blind manual adjustment.
CREATE OR REPLACE FUNCTION public.rpc_reconcile_customer_debt(
  p_customer_id text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  ledger_state record;
  old_balance numeric;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF p_customer_id IS NULL OR btrim(p_customer_id) = ''
     OR p_reason IS NULL OR length(btrim(p_reason)) < 8 THEN
    RAISE EXCEPTION 'Customer and a reconciliation reason of at least 8 characters are required';
  END IF;

  SELECT * INTO STRICT customer_row
  FROM public.customers customer
  WHERE customer.id = p_customer_id
  FOR UPDATE;
  old_balance := round(COALESCE(customer_row.debt, 0));

  SELECT * INTO STRICT ledger_state
  FROM public.p74_customer_debt_ledger_balance(customer_row.id);
  IF ledger_state.ledger_count = 0 OR ledger_state.calculated_balance IS NULL THEN
    RAISE EXCEPTION 'Customer has no debt ledger to reconcile';
  END IF;

  IF old_balance IS DISTINCT FROM ledger_state.calculated_balance THEN
    UPDATE public.customers
    SET debt = ledger_state.calculated_balance,
        updated_at = now(),
        updated_by = actor.auth_user_id::text
    WHERE id = customer_row.id;

    INSERT INTO public.audit_logs(
      table_name, action, record_id, old_data, new_data, performed_by, created_at
    ) VALUES (
      'customers', 'RECONCILE_DEBT_AGGREGATE', customer_row.id,
      jsonb_build_object('debt', old_balance),
      jsonb_build_object(
        'debt', ledger_state.calculated_balance,
        'ledger_count', ledger_state.ledger_count,
        'opening_balance', ledger_state.opening_balance,
        'debt_change_total', ledger_state.debt_change_total,
        'reason', btrim(p_reason)
      ),
      actor.auth_user_id::text, now()
    );
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'customer_id', customer_row.id,
    'old_debt', old_balance,
    'new_debt', ledger_state.calculated_balance,
    'changed', old_balance IS DISTINCT FROM ledger_state.calculated_balance,
    'ledger_count', ledger_state.ledger_count
  );
END;
$$;

-- Targeted production incident repair for Anh Thuy / Thuy VP. The update runs
-- only when all four reviewed source documents belong to one customer and
-- their exact debt effects match the supplied evidence. Any other dataset is
-- left untouched.
DO $$
DECLARE
  incident_customer_id text;
  incident_customer_name text;
  old_balance numeric;
  ledger_state record;
BEGIN
  SELECT sale_1682.customer_id, customer.name
  INTO incident_customer_id, incident_customer_name
  FROM public.orders sale_1682
  JOIN public.orders sale_1684
    ON sale_1684.id = 'HD-20260918-00001684'
   AND sale_1684.customer_id = sale_1682.customer_id
  JOIN public.customers customer ON customer.id = sale_1682.customer_id
  WHERE sale_1682.id = 'HD-20260918-00001682'
    AND EXISTS (
      SELECT 1 FROM public.customer_debt_transactions ledger
      WHERE ledger.customer_id = sale_1682.customer_id
        AND ledger.order_id = sale_1682.id
        AND ledger.transaction_type = 'order'
        AND round(ledger.debt_change) = 10660388
    )
    AND EXISTS (
      SELECT 1 FROM public.customer_debt_transactions ledger
      WHERE ledger.customer_id = sale_1682.customer_id
        AND ledger.order_id = sale_1684.id
        AND ledger.transaction_type = 'order'
        AND round(ledger.debt_change) = 650000
    )
    AND EXISTS (
      SELECT 1 FROM public.customer_debt_transactions ledger
      WHERE ledger.customer_id = sale_1682.customer_id
        AND ledger.cashbook_transaction_id = 'PT-20260915-00000887'
        AND ledger.transaction_type = 'payment'
        AND round(ledger.debt_change) = -8000000
    )
    AND EXISTS (
      SELECT 1 FROM public.customer_debt_transactions ledger
      WHERE ledger.customer_id = sale_1682.customer_id
        AND ledger.cashbook_transaction_id = 'PT-20260918-00000927'
        AND ledger.transaction_type = 'payment'
        AND round(ledger.debt_change) = -10000000
    )
  LIMIT 1;

  IF incident_customer_id IS NULL THEN
    RETURN;
  END IF;

  SELECT round(COALESCE(debt, 0)) INTO STRICT old_balance
  FROM public.customers WHERE id = incident_customer_id FOR UPDATE;
  SELECT * INTO STRICT ledger_state
  FROM public.p74_customer_debt_ledger_balance(incident_customer_id);

  IF old_balance IS DISTINCT FROM ledger_state.calculated_balance THEN
    UPDATE public.customers
    SET debt = ledger_state.calculated_balance,
        updated_at = now()
    WHERE id = incident_customer_id;

    INSERT INTO public.audit_logs(
      table_name, action, record_id, old_data, new_data, performed_by, created_at
    ) VALUES (
      'customers', 'RECONCILE_DEBT_AGGREGATE', incident_customer_id,
      jsonb_build_object('debt', old_balance),
      jsonb_build_object(
        'debt', ledger_state.calculated_balance,
        'customer_name', incident_customer_name,
        'reviewed_balance_at_incident', 1358284,
        'reason', 'Reviewed HD-20260918-00001682, HD-20260918-00001684, PT-20260915-00000887 and PT-20260918-00000927; later ledger activity, if any, is included'
      ),
      'migration:0074', now()
    );
  END IF;
END;
$$;

-- Repair invoice-only snapshots from canonical posting arithmetic. Business
-- ledger rows remain append-only. This is deliberately scoped to the reviewed
-- incident documents and does not rewrite unrelated invoices.
WITH ordered_ledger AS (
  SELECT
    ledger.id,
    ledger.customer_id,
    ledger.order_id,
    round(first_value(ledger.balance_before) OVER customer_posting
      + COALESCE(sum(ledger.debt_change) OVER (
          PARTITION BY ledger.customer_id
          ORDER BY COALESCE(ledger.created_at, ledger.transaction_date), ledger.id
          ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), 0)) AS expected_before
  FROM public.customer_debt_transactions ledger
  WINDOW customer_posting AS (
    PARTITION BY ledger.customer_id
    ORDER BY COALESCE(ledger.created_at, ledger.transaction_date), ledger.id
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  )
), incident_order_snapshots AS (
  SELECT DISTINCT ON (ledger.order_id)
    ledger.order_id,
    ledger.customer_id,
    ledger.id AS ledger_id,
    ledger.expected_before,
    ledger.expected_before + round(COALESCE(sale.debt_amount, 0)) AS expected_after
  FROM ordered_ledger ledger
  JOIN public.orders sale
    ON sale.id = ledger.order_id
   AND sale.customer_id = ledger.customer_id
  WHERE ledger.order_id IN ('HD-20260918-00001682', 'HD-20260918-00001684')
  ORDER BY ledger.order_id, ledger.id
)
UPDATE public.orders sale
SET debt_before_snapshot = snapshot.expected_before,
    debt_after_snapshot = snapshot.expected_after,
    debt_snapshot_customer_id = snapshot.customer_id,
    debt_snapshot_ledger_id = snapshot.ledger_id,
    debt_snapshot_basis = 'ledger_posting_reconciled_v2'
FROM incident_order_snapshots snapshot
WHERE sale.id = snapshot.order_id
  AND (
    sale.debt_before_snapshot IS DISTINCT FROM snapshot.expected_before
    OR sale.debt_after_snapshot IS DISTINCT FROM snapshot.expected_after
    OR sale.debt_snapshot_customer_id IS DISTINCT FROM snapshot.customer_id
  );

REVOKE ALL ON FUNCTION public.p74_customer_debt_ledger_balance(text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.p74_guard_customer_debt_invariant()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_reconcile_customer_debt(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_reconcile_customer_debt(text, text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0074', 'Enforce all customer debt invariants and reconcile reviewed Thuy VP incident')
ON CONFLICT (version) DO NOTHING;

COMMIT;
