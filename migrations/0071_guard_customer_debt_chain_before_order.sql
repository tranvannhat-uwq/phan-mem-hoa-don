BEGIN;

-- Do not compound an existing customer-balance mismatch when a new order is
-- finalized. The order RPC uses customers.debt as its atomic starting point;
-- this guard makes sure that value still agrees with the last immutable ledger
-- snapshot before the order is allowed to create the next snapshot.
CREATE OR REPLACE FUNCTION public.p71_guard_customer_debt_chain_before_order()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  customer_balance numeric;
  last_ledger_balance numeric;
  last_ledger_id text;
BEGIN
  IF NEW.transaction_type NOT IN ('order', 'order_amend')
     OR NEW.customer_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT round(COALESCE(customer.debt, 0))
  INTO STRICT customer_balance
  FROM public.customers customer
  WHERE customer.id = NEW.customer_id;

  SELECT round(ledger.balance_after), ledger.id
  INTO last_ledger_balance, last_ledger_id
  FROM public.customer_debt_transactions ledger
  WHERE ledger.customer_id = NEW.customer_id
  ORDER BY ledger.created_at DESC, ledger.id DESC
  LIMIT 1;

  -- A legacy customer may have a non-zero balance without any ledger rows;
  -- preserve that compatibility. Once a ledger exists, the chain must agree.
  IF last_ledger_id IS NOT NULL
     AND customer_balance IS DISTINCT FROM last_ledger_balance THEN
    RAISE EXCEPTION
      'Customer debt chain mismatch for %: customers.debt=% but latest ledger % ends at %. Reconcile before confirming a new order.',
      NEW.customer_id, customer_balance, last_ledger_id, last_ledger_balance
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p71_guard_customer_debt_chain_before_order
  ON public.customer_debt_transactions;
CREATE TRIGGER p71_guard_customer_debt_chain_before_order
BEFORE INSERT ON public.customer_debt_transactions
FOR EACH ROW
EXECUTE FUNCTION public.p71_guard_customer_debt_chain_before_order();

REVOKE ALL ON FUNCTION public.p71_guard_customer_debt_chain_before_order()
  FROM PUBLIC, anon, authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0071', 'Block new orders when customer debt and immutable ledger diverge')
ON CONFLICT (version) DO NOTHING;

COMMIT;
