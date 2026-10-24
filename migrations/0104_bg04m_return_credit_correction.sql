BEGIN;

-- The owner confirmed that returns remain customer credit, never cash payouts.
-- Correct only the reviewed automatic cash voucher for RET3-...25. The return,
-- its item quantities, order totals, sales and stock movements are preserved.
DO $repair$
DECLARE
  customer_row public.customers%ROWTYPE;
  return_row public.sales_returns%ROWTYPE;
  voucher public.cashbook_transactions%ROWTYPE;
  ledger_state record;
  return_id constant text := 'RET3-20261024-00000025';
  customer_id constant text := 'cust-1785809280224-455-820';
  voucher_id constant text := 'PC-RET-20261024-00001827';
  order_id constant text := 'HD-20261017-00002796';
  credit_id constant text := 'DTX-RET3-CREDIT-RET3-20261024-00000025';
  actor constant text := 'migration-0104';
  reason constant text := 'Chuyển phiếu chi tự động sang tiền trả hàng giữ cấn trừ công nợ theo xác nhận của chủ hệ thống';
  old_snapshot jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='0103') THEN
    RAISE EXCEPTION '0104 stopped: apply 0103 before correcting the historical refund.';
  END IF;
  -- Lock in the same order as the return RPC so concurrent customer activity
  -- cannot cause an unchecked balance overwrite.
  PERFORM 1 FROM public.orders o WHERE o.id=order_id FOR UPDATE;
  SELECT * INTO STRICT customer_row FROM public.customers c WHERE c.id=customer_id FOR UPDATE;
  SELECT * INTO STRICT return_row FROM public.sales_returns r WHERE r.id=return_id FOR UPDATE;
  SELECT * INTO STRICT voucher FROM public.cashbook_transactions cb WHERE cb.id=voucher_id FOR UPDATE;

  IF EXISTS (SELECT 1 FROM public.customer_debt_transactions d WHERE d.id=credit_id) THEN
    IF return_row.debt_ledger_id IS DISTINCT FROM credit_id
      OR return_row.debt_reduction_amount IS DISTINCT FROM 2166592::numeric
      OR return_row.refund_amount IS DISTINCT FROM 0::numeric
      OR return_row.refund_cashbook_transaction_id IS NOT NULL
      OR voucher.status IS DISTINCT FROM 'cancelled'
      OR NOT EXISTS (SELECT 1 FROM public.cashbook_transactions cb
        WHERE cb.id='VOID-'||voucher_id AND cb.reversal_of_id=voucher_id AND cb.value=2166592) THEN
      RAISE EXCEPTION '0104 correction marker exists but documents do not match; stop for review.';
    END IF;
    RETURN;
  END IF;

  SELECT * INTO STRICT ledger_state FROM public.p74_customer_debt_ledger_balance(customer_id);
  IF customer_row.code IS DISTINCT FROM 'ĐINH XUÂN HIẾU - NANO10 - QUẢNG BÌNH - BG04M'
    OR customer_row.debt IS DISTINCT FROM -23::numeric
    OR ledger_state.calculated_balance IS DISTINCT FROM -23::numeric
    OR customer_row.total_return IS DISTINCT FROM 2166592::numeric
    OR customer_row.net_revenue IS DISTINCT FROM 1338233684::numeric THEN
    RAISE EXCEPTION '0104 stopped: BG04M totals changed since the reviewed preflight.';
  END IF;
  IF return_row.customer_id IS DISTINCT FROM customer_id
    OR return_row.sale_id IS DISTINCT FROM order_id OR return_row.order_id IS DISTINCT FROM order_id
    OR return_row.status IS DISTINCT FROM 'completed'
    OR return_row.total_refund IS DISTINCT FROM 2166592::numeric
    OR return_row.total_return_amount IS DISTINCT FROM 2166592::numeric
    OR return_row.debt_reduction_amount IS DISTINCT FROM 0::numeric
    OR return_row.refund_amount IS DISTINCT FROM 2166592::numeric
    OR return_row.debt_ledger_id IS NOT NULL
    OR return_row.refund_cashbook_transaction_id IS DISTINCT FROM voucher_id
    OR return_row.request_fingerprint IS DISTINCT FROM '48c8fb1603d652ee950b0ebe47dd8627'
    OR EXISTS (SELECT 1 FROM public.customer_debt_transactions d WHERE d.sales_return_id=return_id) THEN
    RAISE EXCEPTION '0104 stopped: return 25 no longer matches the reviewed cash-only return.';
  END IF;
  IF voucher.customer_id IS DISTINCT FROM customer_id
    OR voucher.sales_return_id IS DISTINCT FROM return_id
    OR voucher.order_id IS DISTINCT FROM order_id
    OR voucher.transaction_type IS DISTINCT FROM 'sales_return_refund'
    OR voucher.type IS DISTINCT FROM 'chi' OR voucher.direction IS DISTINCT FROM 'out'
    OR voucher.status IS DISTINCT FROM 'completed' OR voucher.value IS DISTINCT FROM 2166592::numeric
    OR voucher.accounting IS DISTINCT FROM false OR voucher.method IS DISTINCT FROM 'cash'
    OR voucher.amended_at IS NOT NULL OR COALESCE(voucher.amendment_count,0) <> 0
    OR voucher.reversal_of_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.cashbook_transactions cb WHERE cb.reversal_of_id=voucher_id) THEN
    RAISE EXCEPTION '0104 stopped: the automatic refund voucher was changed after review.';
  END IF;

  old_snapshot := jsonb_build_object('customer_debt',customer_row.debt,
    'return_amount_snapshot',to_jsonb(return_row),'refund_voucher_snapshot',to_jsonb(voucher));

  UPDATE public.cashbook_transactions cb SET status='cancelled', cancelled_at=now(),
    cancelled_by=actor, cancellation_reason=reason, updated_by=actor WHERE cb.id=voucher_id;
  -- Follow the existing refund cancellation convention. Both cancelled rows
  -- remain for audit; this is a bookkeeping reversal, not a real cash receipt.
  INSERT INTO public.cashbook_transactions(id,date,transaction_date,type,transaction_type,direction,
    category,partner,customer_id,order_id,sales_return_id,value,method,payment_method,accounting,
    status,creator,created_by,note,starred,reversal_of_id)
  VALUES ('VOID-'||voucher_id,now(),now(),'thu','sales_return_refund_reversal','in',
    'Đảo hoàn tiền trả hàng',voucher.partner,customer_id,order_id,return_id,2166592,
    voucher.method,voucher.payment_method,false,'cancelled','Chuyển trả hàng sang cấn trừ',actor,
    reason,false,voucher_id);

  INSERT INTO public.customer_debt_transactions(id,customer_id,transaction_type,amount,debt_change,
    balance_before,balance_after,sales_return_id,order_id,description,created_by,transaction_date)
  VALUES (credit_id,customer_id,'return',2166592,-2166592,-23,-2166615,return_id,order_id,
    reason,actor,COALESCE(return_row.return_date,return_row.created_at));
  UPDATE public.customers c SET debt=-2166615,updated_at=now(),updated_by=actor WHERE c.id=customer_id;
  UPDATE public.sales_returns r SET debt_reduction_amount=2166592,refund_amount=0,
    refund_cashbook_transaction_id=NULL,debt_ledger_id=credit_id,updated_at=now(),updated_by=actor
    WHERE r.id=return_id;

  INSERT INTO public.audit_logs(table_name,action,record_id,old_data,new_data,performed_by)
  VALUES ('sales_returns','CONVERT_AUTOMATIC_REFUND_TO_CREDIT',return_id,old_snapshot,
    jsonb_build_object('customer_debt',-2166615,'return_credit_amount',2166592,'refund_amount',0,
      'credit_debt_ledger_id',credit_id,'cancelled_refund_voucher_id',voucher_id,'reason',reason,
      'preserved_sales_and_stock',true),actor);
END $repair$;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0104','Convert BG04M return 25 automatic cash voucher to retained customer credit')
ON CONFLICT (version) DO NOTHING;
COMMIT;
