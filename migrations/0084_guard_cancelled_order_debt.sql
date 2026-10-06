BEGIN;

-- The customer-balance invariant checks ledger arithmetic, but cannot tell
-- whether a cancelled invoice still contributes to debt. Check that business
-- invariant at the cancelled-status transition, after every atomic ledger
-- write in the transaction. Receipts are independent and are not included.
CREATE OR REPLACE FUNCTION public.p84_guard_cancelled_order_debt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  final_status text;
  open_customer_id text;
  open_amount numeric;
BEGIN
  SELECT sale.status INTO final_status
  FROM public.orders sale WHERE sale.id = NEW.id;
  IF final_status NOT IN ('cancelled', 'canceled') THEN
    RETURN NEW;
  END IF;

  -- Legacy orders without an order ledger follow the existing fallback path.
  -- For ledger-backed orders, every customer in a transfer chain must have no
  -- order-owned balance after the cancellation. A cancelled return contributes
  -- its matching return_cancel row; linked receipts remain untouched.
  SELECT net.customer_id, net.debt_change
  INTO open_customer_id, open_amount
  FROM (
    SELECT d.customer_id, round(sum(COALESCE(d.debt_change, 0))) AS debt_change
    FROM public.customer_debt_transactions d
    WHERE d.order_id = NEW.id
      AND d.transaction_type IN (
        'order', 'order_amend', 'return', 'return_cancel', 'order_cancel'
      )
    GROUP BY d.customer_id
    HAVING count(*) FILTER (
      WHERE d.transaction_type IN ('order', 'order_amend')
    ) > 0
      AND round(sum(COALESCE(d.debt_change, 0))) <> 0
  ) net
  ORDER BY net.customer_id
  LIMIT 1;

  IF open_customer_id IS NOT NULL THEN
    RAISE EXCEPTION
      'Không thể hủy đơn %: bút toán công nợ của khách % còn chênh %',
      NEW.id, open_customer_id, open_amount
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p84_guard_cancelled_order_debt ON public.orders;
CREATE CONSTRAINT TRIGGER p84_guard_cancelled_order_debt
AFTER UPDATE OF status ON public.orders
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.status IN ('cancelled', 'canceled')
  AND COALESCE(OLD.status, '') NOT IN ('cancelled', 'canceled'))
EXECUTE FUNCTION public.p84_guard_cancelled_order_debt();

REVOKE ALL ON FUNCTION public.p84_guard_cancelled_order_debt() FROM PUBLIC, anon;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0084', 'Reject cancelled ledger-backed orders with residual order debt')
ON CONFLICT (version) DO NOTHING;

COMMIT;
