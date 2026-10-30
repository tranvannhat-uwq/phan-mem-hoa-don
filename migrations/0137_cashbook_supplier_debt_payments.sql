BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';

-- Install functions only. Existing vouchers are reconciled individually after
-- review; installing this migration never changes historical balances.
DO $guard$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='0135') THEN
    RAISE EXCEPTION 'Migration 0137 requires migration 0135.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='0137') THEN
    RAISE EXCEPTION 'Migration 0137 is already recorded.';
  END IF;
END $guard$;

CREATE FUNCTION public.rpc_reconcile_supplier_cashbook_payment(p_cashbook_id text,p_supplier_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  entry public.cashbook_transactions%ROWTYPE;
  supplier_row public.suppliers%ROWTYPE;
  payment public.purchase_payments%ROWTYPE;
  payment_id text;
  request_key text;
  business_date timestamptz;
  already_linked boolean:=false;
BEGIN
  actor:=public.require_authenticated_profile();
  IF actor.role NOT IN ('admin','accounting') OR NOT public.maintenance_access_allowed() THEN
    RAISE EXCEPTION 'Chỉ Admin hoặc Kế toán được ghi phiếu chi vào công nợ.' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT entry FROM public.cashbook_transactions
    WHERE id=NULLIF(btrim(p_cashbook_id),'') FOR UPDATE;
  IF entry.type IS DISTINCT FROM 'chi' OR entry.value IS NULL OR entry.value<=0
     OR entry.value::text IN ('NaN','Infinity','-Infinity') OR entry.value<>round(entry.value)
     OR entry.reversal_of_id IS NOT NULL OR entry.cancelled_at IS NOT NULL
     OR lower(COALESCE(entry.status,'')) NOT IN ('completed','paid','đã thanh toán') THEN
    RAISE EXCEPTION 'Chỉ ghi công nợ cho phiếu chi đã thanh toán, số VNĐ nguyên dương.';
  END IF;
  SELECT * INTO STRICT supplier_row FROM public.suppliers WHERE id=p_supplier_id FOR UPDATE;
  SELECT * INTO payment FROM public.purchase_payments WHERE cashbook_transaction_id=entry.id;
  IF FOUND THEN
    IF payment.supplier_id IS DISTINCT FROM p_supplier_id OR payment.id IS DISTINCT FROM entry.purchase_payment_id
       OR payment.status IS DISTINCT FROM 'completed' THEN
      RAISE EXCEPTION 'Phiếu chi đã liên kết với nghiệp vụ thanh toán khác.';
    END IF;
    payment_id:=payment.id;
    already_linked:=true;
  ELSE
    IF supplier_row.is_active IS DISTINCT FROM true THEN RAISE EXCEPTION 'Nhà cung cấp đã ngừng hoạt động.'; END IF;
    IF COALESCE(entry.transaction_type,'') NOT IN ('','manual_chi')
       OR entry.customer_id IS NOT NULL OR entry.order_id IS NOT NULL OR entry.sales_return_id IS NOT NULL
       OR entry.purchase_id IS NOT NULL OR entry.purchase_payment_id IS NOT NULL
       OR (entry.supplier_id IS NOT NULL AND entry.supplier_id<>p_supplier_id)
       OR COALESCE(entry.counterparty_type,'other') NOT IN ('other','supplier')
       OR (NULLIF(entry.counterparty_id,'') IS NOT NULL AND entry.counterparty_id<>p_supplier_id) THEN
      RAISE EXCEPTION 'Phiếu chi đã thuộc nghiệp vụ khác; không thể tự chuyển công nợ.';
    END IF;
    IF entry.category NOT IN ('Chi tiền nhập hàng','Thanh toán nhà cung cấp') OR entry.category IS NULL THEN
      RAISE EXCEPTION 'Chỉ ghi công nợ cho chi tiền nhập hàng hoặc thanh toán nhà cung cấp.';
    END IF;
    IF lower(btrim(COALESCE(entry.partner,''))) NOT IN (
      lower(btrim(supplier_row.name)),lower(btrim(supplier_row.code)),
      lower(btrim(supplier_row.name||' — '||supplier_row.code)),
      lower(btrim(supplier_row.name||' - '||supplier_row.code))) THEN
      RAISE EXCEPTION 'Người nhận trên phiếu không khớp nhà cung cấp đã chọn.';
    END IF;
    -- Preserve the same outstanding-debt limit as unallocated supplier payments.
    IF entry.value>supplier_row.debt THEN RAISE EXCEPTION 'Số tiền chi vượt công nợ còn phải trả nhà cung cấp.'; END IF;
    business_date:=COALESCE(entry.transaction_date,entry.date);
    request_key:='cashbook-supplier:'||md5(entry.id);
    payment_id:='SPAY-'||replace(gen_random_uuid()::text,'-','');
    INSERT INTO public.purchase_payments(id,supplier_id,amount,payment_method,cashbook_transaction_id,
      status,notes,idempotency_key,request_fingerprint,created_by,created_at)
    VALUES(payment_id,p_supplier_id,entry.value,COALESCE(entry.payment_method,entry.method),entry.id,
      'completed',entry.note,request_key,md5(entry.id||':'||p_supplier_id),actor.auth_user_id::text,business_date);
    INSERT INTO public.supplier_debt_transactions(id,supplier_id,payment_id,transaction_type,
      amount_change,balance_after,idempotency_key,notes,created_by,transaction_date)
    VALUES('SDL-'||replace(gen_random_uuid()::text,'-',''),p_supplier_id,payment_id,'supplier_payment',
      -entry.value,supplier_row.debt-entry.value,request_key,entry.note,actor.auth_user_id::text,business_date);
    UPDATE public.cashbook_transactions SET transaction_type='supplier_payment',operation_type='supplier_payment',
      reference_type='supplier',reference_id=p_supplier_id,supplier_id=p_supplier_id,purchase_payment_id=payment_id,
      counterparty_type='supplier',counterparty_id=p_supplier_id,updated_by=actor.auth_user_id::text
    WHERE id=entry.id;
    PERFORM public.p4_recompute_supplier(p_supplier_id);
    INSERT INTO public.audit_logs(table_name,action,record_id,old_data,new_data,performed_by,created_at)
    VALUES('cashbook_transactions','RECONCILE_SUPPLIER_PAYMENT',entry.id,to_jsonb(entry),
      jsonb_build_object('supplier_id',p_supplier_id,'payment_id',payment_id,'amount',entry.value,
        'debt_before',supplier_row.debt,'debt_after',(SELECT debt FROM public.suppliers WHERE id=p_supplier_id)),
      actor.auth_user_id::text,now());
  END IF;
  RETURN public.p2_cashbook_response(entry.id)||public.p4_supplier_response(p_supplier_id)
    ||jsonb_build_object('already_reconciled',already_linked,'payment_id',payment_id,'supplier_id',p_supplier_id);
END $$;
REVOKE ALL ON FUNCTION public.rpc_reconcile_supplier_cashbook_payment(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_reconcile_supplier_cashbook_payment(text,text) TO authenticated;

CREATE FUNCTION public.rpc_create_supplier_cashbook_payment(p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; supplier_row public.suppliers%ROWTYPE; created jsonb;
BEGIN
  actor:=public.require_authenticated_profile();
  IF actor.role NOT IN ('admin','accounting') OR NOT public.maintenance_access_allowed() THEN
    RAISE EXCEPTION 'Chỉ Admin hoặc Kế toán được lập phiếu chi nhà cung cấp.' USING ERRCODE='42501';
  END IF;
  IF p_input->>'type' IS DISTINCT FROM 'chi' OR COALESCE(p_input->>'value','') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Phiếu chi cần số tiền VNĐ nguyên dương.';
  END IF;
  SELECT * INTO STRICT supplier_row FROM public.suppliers WHERE id=p_input->>'supplierId';
  -- The existing cashbook RPC owns date, method, accounting, code and retry
  -- validation. Both calls run in this transaction: any linkage failure rolls
  -- back the cashbook row as well. Never fall back to a standalone payment.
  created:=public.rpc_create_cashbook_transaction((p_input-'supplierId')||jsonb_build_object('partner',supplier_row.name));
  RETURN public.rpc_reconcile_supplier_cashbook_payment(created->>'cashbook_id',supplier_row.id)
    ||jsonb_build_object('already_recorded',COALESCE((created->>'already_recorded')::boolean,false));
END $$;
REVOKE ALL ON FUNCTION public.rpc_create_supplier_cashbook_payment(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_supplier_cashbook_payment(jsonb) TO authenticated;

INSERT INTO public.schema_migrations(version,description)
VALUES('0137','Atomic supplier debt payments from cashbook and explicit same-voucher reconciliation');
NOTIFY pgrst,'reload schema';
COMMIT;
