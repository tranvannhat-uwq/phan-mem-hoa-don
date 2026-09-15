BEGIN;

-- Order confirmation and in-place amendment intentionally write the two sides
-- of the customer-debt invariant in opposite orders:
--   * confirmation inserts the ledger row, then updates customers.debt;
--   * amendment updates customers.debt, then inserts the ledger delta.
-- A BEFORE INSERT trigger therefore observes a legitimate half-finished state
-- in one of those flows. Check the invariant at transaction end instead, when
-- all atomic writes are visible, while still rolling the transaction back if
-- the final customer balance and immutable ledger arithmetic do not agree.
CREATE OR REPLACE FUNCTION public.p71_guard_customer_debt_chain_before_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  customer_balance numeric;
  ledger_opening_balance numeric;
  ledger_change_total numeric;
  ledger_calculated_balance numeric;
BEGIN
  IF NEW.transaction_type NOT IN ('order', 'order_amend')
     OR NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

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

  SELECT round(COALESCE(customer.debt, 0))
  INTO STRICT customer_balance
  FROM public.customers customer
  WHERE customer.id = NEW.customer_id;

  SELECT
    round(COALESCE(opening.balance_before, 0)),
    round(COALESCE(sum(ledger.debt_change), 0))
  INTO STRICT ledger_opening_balance, ledger_change_total
  FROM public.customer_debt_transactions ledger
  CROSS JOIN LATERAL (
    SELECT first_ledger.balance_before
    FROM public.customer_debt_transactions first_ledger
    WHERE first_ledger.customer_id = NEW.customer_id
    ORDER BY first_ledger.created_at, first_ledger.id
    LIMIT 1
  ) opening
  WHERE ledger.customer_id = NEW.customer_id
  GROUP BY opening.balance_before;

  ledger_calculated_balance := ledger_opening_balance + ledger_change_total;

  IF customer_balance IS DISTINCT FROM ledger_calculated_balance THEN
    RAISE EXCEPTION
      'Customer debt chain mismatch for %: customers.debt=% but ledger arithmetic yields %. Reconcile before confirming or amending an order.',
      NEW.customer_id, customer_balance, ledger_calculated_balance
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p71_guard_customer_debt_chain_before_order
  ON public.customer_debt_transactions;
CREATE CONSTRAINT TRIGGER p71_guard_customer_debt_chain_before_order
AFTER INSERT ON public.customer_debt_transactions
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.p71_guard_customer_debt_chain_before_order();

REVOKE ALL ON FUNCTION public.p71_guard_customer_debt_chain_before_order()
  FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger trigger_row
    WHERE trigger_row.tgrelid = 'public.customer_debt_transactions'::regclass
      AND trigger_row.tgname = 'p71_guard_customer_debt_chain_before_order'
      AND trigger_row.tgconstraint <> 0
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Migration 0072 stopped: deferred customer debt guard was not installed';
  END IF;
END;
$$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0072', 'Defer customer debt consistency checks until atomic order writes complete')
ON CONFLICT (version) DO NOTHING;

COMMIT;
