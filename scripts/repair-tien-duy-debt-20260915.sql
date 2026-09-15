-- SAFE, ONE-TIME REPAIR for:
-- TIẾN DUY - NANO10 - LÀO CAI - BG03M (K TRỪ 3%)
--
-- Run as an authenticated admin/accounting session against the live DB.
-- The guards intentionally abort if the live values no longer match the
-- incident snapshot. This appends an audited adjustment; it never edits or
-- deletes immutable history.

BEGIN;

DO $$
DECLARE
  v_customer public.customers%ROWTYPE;
  v_latest_balance numeric;
  v_latest_id text;
BEGIN
  SELECT * INTO STRICT v_customer
  FROM public.customers
  WHERE code = 'TIẾN DUY - NANO10 - LÀO CAI - BG03M (K TRỪ 3%)';

  SELECT round(ledger.balance_after), ledger.id
  INTO v_latest_balance, v_latest_id
  FROM public.customer_debt_transactions ledger
  WHERE ledger.customer_id = v_customer.id
  ORDER BY ledger.created_at DESC, ledger.id DESC
  LIMIT 1;

  -- The 15/09 order was subsequently voided. Therefore the live balance and
  -- the latest void ledger snapshot are both 36,218,317, not 48,103,436.
  IF round(COALESCE(v_customer.debt, 0)) <> 36218317
     OR round(COALESCE(v_latest_balance, 0)) <> 36218317 THEN
    RAISE EXCEPTION
      'Repair aborted for %: expected current/latest balance 36218317, got customer=% latest=% (%). Reconcile manually.',
      v_customer.id, round(COALESCE(v_customer.debt, 0)),
      round(COALESCE(v_latest_balance, 0)), COALESCE(v_latest_id, 'none');
  END IF;
END;
$$;

DO $$
DECLARE
  v_customer public.customers%ROWTYPE;
  v_before numeric;
  v_after numeric := 33608532;
  v_latest numeric;
  v_latest_id text;
  v_ledger_id text := 'DTX-ADJ-TIENDUY-20260915-2609785';
  v_reason text := 'Đối soát công nợ: loại phần số dư đầu kỳ nhập nhầm 2.609.785đ; giữ nguyên lịch sử giao dịch';
BEGIN
  -- SQL Editor has no auth.uid(). Restrict this fallback to the database owner.
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Repair must be run by the postgres database owner';
  END IF;

  SELECT * INTO STRICT v_customer
  FROM public.customers
  WHERE code = 'TIẾN DUY - NANO10 - LÀO CAI - BG03M (K TRỪ 3%)'
  FOR UPDATE;

  v_before := round(COALESCE(v_customer.debt, 0));
  SELECT round(ledger.balance_after), ledger.id
  INTO v_latest, v_latest_id
  FROM public.customer_debt_transactions ledger
  WHERE ledger.customer_id = v_customer.id
  ORDER BY ledger.created_at DESC, ledger.id DESC
  LIMIT 1;

  IF v_before = v_after AND round(COALESCE(v_latest, 0)) = v_after THEN
    RAISE NOTICE 'Already repaired: %', v_customer.id;
    RETURN;
  END IF;

  IF v_before <> 36218317 OR round(COALESCE(v_latest, 0)) <> 36218317 THEN
    RAISE EXCEPTION
      'Repair aborted for %: expected current/latest balance 36218317, got customer=% latest=% (%). Reconcile manually.',
      v_customer.id, v_before, round(COALESCE(v_latest, 0)), COALESCE(v_latest_id, 'none');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.customer_debt_transactions
    WHERE id = v_ledger_id
  ) THEN
    RAISE EXCEPTION 'Repair ledger id already exists: %', v_ledger_id;
  END IF;

  INSERT INTO public.customer_debt_transactions(
    id, customer_id, transaction_type, amount, debt_change, balance_before,
    balance_after, description, created_by, transaction_date
  ) VALUES (
    v_ledger_id, v_customer.id, 'adjust', abs(v_after - v_before),
    v_after - v_before, v_before, v_after, v_reason,
    'sql-editor-repair', now()
  );

  UPDATE public.customers
  SET debt = v_after, updated_at = now(), updated_by = 'sql-editor-repair'
  WHERE id = v_customer.id;

  INSERT INTO public.audit_logs(
    table_name, action, record_id, old_data, new_data, performed_by, created_at
  ) VALUES (
    'customers', 'ADJUST_DEBT', v_customer.id,
    jsonb_build_object('debt', v_before),
    jsonb_build_object('debt', v_after, 'ledger_id', v_ledger_id, 'reason', v_reason),
    'sql-editor-repair', now()
  );
END;
$$;

COMMIT;
