BEGIN;

-- Migration 0063: a cashbook receipt date can be amended without changing its
-- value. Older rpc_amend_cashbook_transaction versions then updated only the
-- voucher, leaving the linked customer-debt document on its original time.
-- Ledger rows are append-only, so record a zero-value amendment rather than
-- rewriting the original financial row. The customer-history projection folds
-- this amendment into the receipt and shows the current voucher timestamp.
CREATE OR REPLACE FUNCTION public.p63_align_customer_receipt_ledger_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  source_ledger public.customer_debt_transactions%ROWTYPE;
  effective_date timestamptz := COALESCE(NEW.transaction_date, NEW.date);
  previous_date timestamptz := COALESCE(OLD.transaction_date, OLD.date);
BEGIN
  IF effective_date IS NOT DISTINCT FROM previous_date THEN
    RETURN NEW;
  END IF;
  IF NEW.cancelled_at IS NOT NULL
     OR NEW.reversal_of_id IS NOT NULL
     OR lower(COALESCE(NEW.status, '')) IN ('cancelled', 'canceled', 'đã hủy', 'da huy') THEN
    RETURN NEW;
  END IF;

  SELECT * INTO source_ledger
  FROM public.customer_debt_transactions ledger
  WHERE ledger.cashbook_transaction_id = NEW.id
    AND ledger.transaction_type = 'payment'
    AND ledger.reversal_of_id IS NULL
  ORDER BY ledger.transaction_date, ledger.created_at
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  -- A non-zero payment amendment created by the existing voucher RPC already
  -- carries this timestamp; avoid a redundant zero adjustment.
  IF EXISTS (
    SELECT 1
    FROM public.customer_debt_transactions amendment
    WHERE amendment.cashbook_transaction_id = NEW.id
      AND amendment.transaction_type = 'payment_amend'
      AND amendment.amends_ledger_id = source_ledger.id
      AND amendment.transaction_date IS NOT DISTINCT FROM effective_date
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.customer_debt_transactions(
    id, customer_id, transaction_type, amount, debt_change, balance_before,
    balance_after, cashbook_transaction_id, amends_ledger_id, description,
    created_by, transaction_date
  ) VALUES (
    'DTX-CB-DATE-' || gen_random_uuid()::text,
    source_ledger.customer_id, 'payment_amend', 0, 0,
    source_ledger.balance_after, source_ledger.balance_after,
    NEW.id, source_ledger.id, 'Điều chỉnh thời gian chứng từ ' || NEW.id,
    COALESCE(NULLIF(NEW.updated_by, ''), NEW.created_by), effective_date
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p63_align_customer_receipt_ledger_date ON public.cashbook_transactions;
CREATE TRIGGER p63_align_customer_receipt_ledger_date
AFTER UPDATE OF date, transaction_date ON public.cashbook_transactions
FOR EACH ROW EXECUTE FUNCTION public.p63_align_customer_receipt_ledger_date();

-- Repair prior date-only amendments. A matching amendment makes this safe to
-- rerun and preserves every existing balance and transaction amount.
INSERT INTO public.customer_debt_transactions(
  id, customer_id, transaction_type, amount, debt_change, balance_before,
  balance_after, cashbook_transaction_id, amends_ledger_id, description,
  created_by, transaction_date
)
SELECT
  'DTX-CB-DATE-' || md5(cashbook.id || '|' || effective.effective_date::text),
  ledger.customer_id, 'payment_amend', 0, 0,
  ledger.balance_after, ledger.balance_after,
  cashbook.id, ledger.id, 'Điều chỉnh thời gian chứng từ ' || cashbook.id,
  COALESCE(NULLIF(cashbook.updated_by, ''), cashbook.created_by), effective.effective_date
FROM public.cashbook_transactions cashbook
CROSS JOIN LATERAL (
  SELECT COALESCE(cashbook.transaction_date, cashbook.date) AS effective_date
) effective
JOIN LATERAL (
  SELECT *
  FROM public.customer_debt_transactions candidate
  WHERE candidate.cashbook_transaction_id = cashbook.id
    AND candidate.transaction_type = 'payment'
    AND candidate.reversal_of_id IS NULL
  ORDER BY candidate.transaction_date, candidate.created_at
  LIMIT 1
) ledger ON true
WHERE effective.effective_date IS DISTINCT FROM ledger.transaction_date
  AND cashbook.cancelled_at IS NULL
  AND cashbook.reversal_of_id IS NULL
  AND lower(COALESCE(cashbook.status, '')) NOT IN ('cancelled', 'canceled', 'đã hủy', 'da huy')
  AND NOT EXISTS (
    SELECT 1
    FROM public.customer_debt_transactions amendment
    WHERE amendment.cashbook_transaction_id = cashbook.id
      AND amendment.transaction_type = 'payment_amend'
      AND amendment.amends_ledger_id = ledger.id
      AND amendment.transaction_date IS NOT DISTINCT FROM effective.effective_date
  );

REVOKE ALL ON FUNCTION public.p63_align_customer_receipt_ledger_date()
  FROM PUBLIC, anon, authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0063', 'Align customer debt receipt dates with amended cashbook vouchers')
ON CONFLICT (version) DO NOTHING;

COMMIT;
