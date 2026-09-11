BEGIN;

-- A printed invoice must not reconstruct historical debt from mutable browser
-- state. Persist the ledger snapshot owned by the finalized order and expose it
-- through one narrow, RLS-aware read RPC.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS debt_before_snapshot numeric,
  ADD COLUMN IF NOT EXISTS debt_after_snapshot numeric,
  ADD COLUMN IF NOT EXISTS debt_snapshot_customer_id text,
  ADD COLUMN IF NOT EXISTS debt_snapshot_ledger_id text,
  ADD COLUMN IF NOT EXISTS debt_snapshot_posted_at timestamptz,
  ADD COLUMN IF NOT EXISTS debt_snapshot_basis text;

ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_debt_snapshot_pair_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_debt_snapshot_pair_check CHECK (
    (debt_before_snapshot IS NULL AND debt_after_snapshot IS NULL)
    OR
    (debt_before_snapshot IS NOT NULL AND debt_after_snapshot IS NOT NULL)
  ) NOT VALID;

-- Backfill from immutable posting snapshots. For a transferred order, the
-- first ledger row owned by the order's current customer is the new baseline.
-- Repeated in-place amendments keep the original before-balance; summing the
-- order-owned ledger deltas yields the effective finalized invoice balance.
WITH snapshots AS (
  SELECT
    sale.id AS order_id,
    sale.customer_id,
    first_row.balance_before AS debt_before,
    first_row.balance_before + round(effective_rows.debt_change) AS debt_after,
    latest_row.id AS ledger_id,
    latest_row.created_at AS posted_at
  FROM public.orders sale
  JOIN LATERAL (
    SELECT ledger.balance_before
    FROM public.customer_debt_transactions ledger
    WHERE ledger.order_id = sale.id
      AND ledger.customer_id = sale.customer_id
      AND ledger.transaction_type IN ('order', 'order_amend')
    ORDER BY ledger.created_at, ledger.id
    LIMIT 1
  ) first_row ON true
  JOIN LATERAL (
    SELECT COALESCE(sum(ledger.debt_change), 0) AS debt_change
    FROM public.customer_debt_transactions ledger
    WHERE ledger.order_id = sale.id
      AND ledger.customer_id = sale.customer_id
      AND ledger.transaction_type IN ('order', 'order_amend')
  ) effective_rows ON true
  JOIN LATERAL (
    SELECT ledger.id, ledger.created_at
    FROM public.customer_debt_transactions ledger
    WHERE ledger.order_id = sale.id
      AND ledger.customer_id = sale.customer_id
      AND ledger.transaction_type IN ('order', 'order_amend')
    ORDER BY ledger.created_at DESC, ledger.id DESC
    LIMIT 1
  ) latest_row ON true
  WHERE sale.customer_id IS NOT NULL
)
UPDATE public.orders sale
SET debt_before_snapshot = round(snapshot.debt_before),
    debt_after_snapshot = round(snapshot.debt_after),
    debt_snapshot_customer_id = snapshot.customer_id,
    debt_snapshot_ledger_id = snapshot.ledger_id,
    debt_snapshot_posted_at = snapshot.posted_at,
    debt_snapshot_basis = 'ledger_posting_v1'
FROM snapshots snapshot
WHERE sale.id = snapshot.order_id
  AND (
    sale.debt_before_snapshot IS NULL
    OR sale.debt_after_snapshot IS NULL
    OR sale.debt_snapshot_customer_id IS DISTINCT FROM snapshot.customer_id
  );

ALTER TABLE public.orders VALIDATE CONSTRAINT orders_debt_snapshot_pair_check;

CREATE OR REPLACE FUNCTION public.p69_set_order_debt_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_customer_debt numeric;
BEGIN
  IF NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT round(COALESCE(customer.debt, 0))
    INTO STRICT current_customer_debt
    FROM public.customers customer
    WHERE customer.id = NEW.customer_id;
    NEW.debt_before_snapshot := current_customer_debt;
    NEW.debt_after_snapshot := current_customer_debt
      + round(COALESCE(NEW.debt_amount, NEW.total_amount, NEW.total_payable, 0));
    NEW.debt_snapshot_ledger_id := NULL;
  ELSE
    IF NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
       AND NEW.total_amount IS NOT DISTINCT FROM OLD.total_amount
       AND NEW.items IS NOT DISTINCT FROM OLD.items
       AND OLD.debt_before_snapshot IS NOT NULL
       AND OLD.debt_after_snapshot IS NOT NULL THEN
      -- Order-linked receipts change paid_amount/debt_amount, but they are a
      -- later payment event and must not rewrite the invoice-at-issue snapshot.
      RETURN NEW;
    END IF;

    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR OLD.debt_before_snapshot IS NULL
       OR OLD.debt_after_snapshot IS NULL THEN
      SELECT round(COALESCE(customer.debt, 0))
      INTO STRICT current_customer_debt
      FROM public.customers customer
      WHERE customer.id = NEW.customer_id;
      NEW.debt_before_snapshot := current_customer_debt;
      NEW.debt_snapshot_ledger_id := NULL;
    ELSE
      NEW.debt_before_snapshot := OLD.debt_before_snapshot;
      NEW.debt_snapshot_ledger_id := OLD.debt_snapshot_ledger_id;
    END IF;

    -- "Debt after invoice" belongs to the invoice itself. Later unrelated
    -- customer transactions must not leak into an amended invoice snapshot.
    NEW.debt_after_snapshot := NEW.debt_before_snapshot
      + round(COALESCE(NEW.debt_amount, NEW.total_amount, NEW.total_payable, 0));
  END IF;

  NEW.debt_snapshot_customer_id := NEW.customer_id;
  NEW.debt_snapshot_posted_at := now();
  NEW.debt_snapshot_basis := 'order_transaction_v1';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p69_set_order_debt_snapshot ON public.orders;
CREATE TRIGGER p69_set_order_debt_snapshot
BEFORE INSERT OR UPDATE OF customer_id, total_amount, items ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.p69_set_order_debt_snapshot();

CREATE OR REPLACE FUNCTION public.rpc_get_order_debt_snapshot(
  p_order_id text,
  p_customer_id text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  sale public.orders%ROWTYPE;
  customer_debt numeric;
BEGIN
  actor := public.require_authenticated_profile();
  IF p_order_id IS NULL OR btrim(p_order_id) = ''
     OR p_customer_id IS NULL OR btrim(p_customer_id) = '' THEN
    RAISE EXCEPTION 'Order and customer are required';
  END IF;

  SELECT * INTO STRICT sale
  FROM public.orders candidate
  WHERE candidate.id = p_order_id
    AND candidate.customer_id = p_customer_id;

  IF actor.role = 'sale' AND NOT public.can_access_customer(sale.customer_id) THEN
    RAISE EXCEPTION '403: customer is outside the authenticated Sale scope'
      USING ERRCODE = '42501';
  ELSIF actor.role NOT IN ('admin', 'accounting', 'sale') THEN
    RAISE EXCEPTION '403: active business profile required'
      USING ERRCODE = '42501';
  END IF;

  IF sale.debt_before_snapshot IS NULL
     OR sale.debt_after_snapshot IS NULL
     OR sale.debt_snapshot_customer_id IS DISTINCT FROM sale.customer_id THEN
    RAISE EXCEPTION 'Invoice debt snapshot is unavailable for order %', sale.id;
  END IF;

  SELECT round(COALESCE(customer.debt, 0)) INTO customer_debt
  FROM public.customers customer
  WHERE customer.id = sale.customer_id;

  RETURN jsonb_build_object(
    'orderId', sale.id,
    'customerId', sale.customer_id,
    'debtBefore', round(sale.debt_before_snapshot),
    'debtAfter', round(sale.debt_after_snapshot),
    'currentDebt', customer_debt,
    'ledgerId', sale.debt_snapshot_ledger_id,
    'postedAt', sale.debt_snapshot_posted_at,
    'basis', sale.debt_snapshot_basis
  );
END;
$$;

REVOKE ALL ON FUNCTION public.p69_set_order_debt_snapshot()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_get_order_debt_snapshot(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_order_debt_snapshot(text, text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0069', 'Persist and serve authoritative invoice debt snapshots')
ON CONFLICT (version) DO NOTHING;

COMMIT;
