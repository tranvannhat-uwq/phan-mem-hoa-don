BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='20s';

-- Original rows are retained for reconciliation. They are never cashbook
-- instructions: the export does not identify a bank account or payment method.
CREATE TABLE public.supplier_report_imports (
  id text PRIMARY KEY, payload jsonb NOT NULL, result jsonb NOT NULL DEFAULT '{}',
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.supplier_report_baselines (
  supplier_id text PRIMARY KEY REFERENCES public.suppliers(id),
  import_id text NOT NULL REFERENCES public.supplier_report_imports(id),
  opening numeric NOT NULL, debit numeric NOT NULL, credit numeric NOT NULL, closing numeric NOT NULL,
  period_from date NOT NULL, period_to date NOT NULL, previous_supplier jsonb NOT NULL, previous_ledger jsonb NOT NULL
);
ALTER TABLE public.purchases ADD COLUMN source_report jsonb;
ALTER TABLE public.purchase_payments ADD COLUMN source_report jsonb;
ALTER TABLE public.supplier_debt_transactions ADD COLUMN source_report jsonb;
-- Negative opening balances mean supplier advances. Current payable and the
-- purchase/payment totals keep their existing nonnegative constraints.
ALTER TABLE public.suppliers DROP CONSTRAINT suppliers_financial_nonnegative;
ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_financial_nonnegative
  CHECK (total_purchase >= 0 AND total_paid >= 0 AND debt >= 0);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['supplier_report_imports','supplier_report_baselines'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated',t);
    EXECUTE format('CREATE POLICY finance_read ON public.%I FOR SELECT TO authenticated USING ((SELECT public.is_admin_or_accounting()) AND (SELECT public.maintenance_access_allowed()))',t);
  END LOOP;
END $$;

CREATE FUNCTION public.rpc_import_supplier_debt_report(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; g jsonb; e jsonb; r jsonb; s public.suppliers%ROWTYPE;
  sid text; purchase_id_value text; payment_id_value text; doc_id text; ledger_id text;
  import_id_value text; prior_result jsonb; result_value jsonb; metadata jsonb;
  start_at timestamptz; end_at timestamptz; latest_at timestamptz; at_value timestamptz;
  opening_value numeric; debit_value numeric; credit_value numeric; closing_value numeric;
  amount_value numeric; running_value numeric; subtotal_value numeric;
  count_suppliers integer:=0; count_purchases integer:=0; count_payments integer:=0; count_items integer:=0;
  line_value integer; purchase_sum numeric; payment_sum numeric; supplier_ids text[]:=ARRAY[]::text[];
BEGIN
  actor:=public.require_authenticated_profile();
  IF actor.role NOT IN ('admin','accounting') THEN RAISE EXCEPTION 'Chỉ quản trị/kế toán được nhập công nợ NCC.' USING ERRCODE='42501'; END IF;
  PERFORM set_config('lock_timeout','3s',true);
  IF jsonb_typeof(p_input->'suppliers') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'suppliers') NOT BETWEEN 1 AND 200
     OR octet_length(p_input::text)>4194304 THEN RAISE EXCEPTION 'Báo cáo quá lớn hoặc không hợp lệ.'; END IF;
  start_at:=((p_input->>'from')::date::text||'T00:00:00+07:00')::timestamptz;
  end_at:=(((p_input->>'to')::date+1)::text||'T00:00:00+07:00')::timestamptz;
  IF start_at IS NULL OR end_at IS NULL OR start_at>=end_at OR end_at-start_at>interval '366 days' THEN RAISE EXCEPTION 'Kỳ báo cáo không hợp lệ.'; END IF;
  IF start_at<(SELECT cutoff FROM public.retention_control WHERE id) THEN RAISE EXCEPTION 'Kỳ báo cáo đã đóng, không được phát lại lịch sử cũ.'; END IF;
  -- Serialize baseline imports, then take business locks in supplier ID order.
  PERFORM pg_advisory_xact_lock(hashtext('supplier-debt-report-import'));
  import_id_value:='SRI-'||encode(sha256(convert_to((p_input-'sourceFile')::text,'UTF8')),'hex');
  SELECT result INTO prior_result FROM public.supplier_report_imports WHERE id=import_id_value;
  IF FOUND THEN RETURN prior_result||jsonb_build_object('already_imported',true); END IF;
  PERFORM id FROM public.suppliers WHERE id IN (SELECT value->>'supplierId' FROM jsonb_array_elements(p_input->'suppliers')) ORDER BY id FOR UPDATE;
  SELECT max((entry->>'date')::timestamptz) INTO latest_at
    FROM jsonb_array_elements(p_input->'suppliers') x CROSS JOIN LATERAL jsonb_array_elements(x.value->'entries') entry;
  latest_at:=COALESCE(latest_at,start_at);
  INSERT INTO public.supplier_report_imports(id,payload,created_by) VALUES(import_id_value,p_input,actor.auth_user_id::text);
  FOR g IN SELECT value FROM jsonb_array_elements(p_input->'suppliers') LOOP
    opening_value:=(g->>'opening')::numeric; debit_value:=(g->>'debit')::numeric;
    credit_value:=(g->>'credit')::numeric; closing_value:=(g->>'closing')::numeric;
    IF opening_value IS NULL OR debit_value IS NULL OR credit_value IS NULL OR closing_value IS NULL
       OR opening_value::text IN ('NaN','Infinity','-Infinity') OR debit_value<0 OR credit_value<0 OR closing_value<0
       OR greatest(abs(opening_value),abs(debit_value),abs(credit_value),abs(closing_value))>9007199254740991
       OR opening_value+debit_value-credit_value<>closing_value THEN RAISE EXCEPTION 'Số dư NCC % không khớp.',g->>'code'; END IF;
    IF jsonb_typeof(g->'entries') IS DISTINCT FROM 'array' OR jsonb_array_length(g->'entries')>3000 THEN RAISE EXCEPTION 'Lịch sử NCC không hợp lệ.'; END IF;
    sid:=NULLIF(g->>'supplierId','');
    IF sid IS NULL THEN
      IF EXISTS(SELECT 1 FROM public.suppliers WHERE lower(regexp_replace(btrim(code),'[[:space:]-]+$',''))=lower(regexp_replace(btrim(g->>'code'),'[[:space:]-]+$','')) OR lower(btrim(name))=lower(btrim(g->>'name'))) THEN
        RAISE EXCEPTION 'NCC % đã tồn tại. Hãy tải lại và đối chiếu hồ sơ.',g->>'code';
      END IF;
      sid:='SUP-'||replace(gen_random_uuid()::text,'-','');
      PERFORM public.rpc_save_supplier(jsonb_build_object('id',sid,'code',g->>'code','name',g->>'name','openingDebt',0));
    END IF;
    SELECT * INTO STRICT s FROM public.suppliers WHERE id=sid FOR UPDATE;
    IF sid=ANY(supplier_ids) OR NOT s.is_active OR (lower(regexp_replace(btrim(s.code),'[[:space:]-]+$',''))<>lower(regexp_replace(btrim(g->>'code'),'[[:space:]-]+$','')) AND lower(btrim(s.name))<>lower(btrim(g->>'name'))) THEN RAISE EXCEPTION 'Đối chiếu hồ sơ NCC không hợp lệ.'; END IF;
    supplier_ids:=array_append(supplier_ids,sid);
    IF EXISTS(SELECT 1 FROM public.supplier_report_baselines WHERE supplier_id=sid) THEN RAISE EXCEPTION 'NCC % đã nhập số đầu kỳ. Cần đối chiếu thay vì nhập chồng.',s.code; END IF;
    IF s.opening_debt<>0 OR EXISTS(SELECT 1 FROM public.retention_supplier_balances WHERE supplier_id=sid AND (purchase_carry<>0 OR paid_carry<>0))
       OR EXISTS(SELECT 1 FROM public.purchases WHERE supplier_id=sid AND purchase_date<=latest_at)
       OR EXISTS(SELECT 1 FROM public.purchase_payments WHERE supplier_id=sid AND created_at<=latest_at)
       OR EXISTS(SELECT 1 FROM public.supplier_debt_transactions WHERE supplier_id=sid AND transaction_date<=latest_at)
    THEN RAISE EXCEPTION 'NCC % có lịch sử/số dư trùng kỳ. Chưa nhập; cần đối chiếu trước.',s.code; END IF;
    SELECT COALESCE(sum((v->>'amount')::numeric) FILTER(WHERE v->>'type'='purchase'),0),
      COALESCE(-sum((v->>'amount')::numeric) FILTER(WHERE v->>'type'='payment'),0)
      INTO purchase_sum,payment_sum FROM jsonb_array_elements(g->'entries') v;
    IF purchase_sum<>debit_value OR payment_sum<>credit_value THEN RAISE EXCEPTION 'Lịch sử không khớp ghi nợ/ghi có NCC %.',s.code; END IF;
    INSERT INTO public.supplier_report_baselines VALUES(sid,import_id_value,opening_value,debit_value,credit_value,closing_value,(p_input->>'from')::date,(p_input->>'to')::date,to_jsonb(s),
      COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM public.supplier_debt_transactions t WHERE supplier_id=sid),'[]'::jsonb));
    -- Existing later transactions remain intact. Their running balances now
    -- start after the imported closing balance instead of the former zero.
    UPDATE public.supplier_debt_transactions SET balance_after=balance_after+closing_value WHERE supplier_id=sid AND transaction_date>latest_at;
    UPDATE public.suppliers SET opening_debt=opening_value,updated_by=actor.auth_user_id::text,updated_at=now() WHERE id=sid;
    metadata:=jsonb_build_object('importId',import_id_value,'file',p_input->>'sourceFile','from',p_input->>'from','to',p_input->>'to');
    INSERT INTO public.supplier_debt_transactions(id,supplier_id,transaction_type,amount_change,balance_after,notes,created_by,transaction_date,source_report)
    VALUES('SDL-'||replace(gen_random_uuid()::text,'-',''),sid,'opening_balance',opening_value,opening_value,'Số dư đầu kỳ theo báo cáo NCC',actor.auth_user_id::text,start_at,metadata);
    running_value:=opening_value;
    FOR e IN SELECT value FROM jsonb_array_elements(g->'entries') ORDER BY (value->>'date')::timestamptz,value->>'code' LOOP
      at_value:=(e->>'date')::timestamptz; amount_value:=(e->>'amount')::numeric;
      IF at_value IS NULL OR at_value<start_at OR at_value>=end_at OR NULLIF(btrim(e->>'code'),'') IS NULL OR amount_value IS NULL OR amount_value::text IN ('NaN','Infinity','-Infinity') OR abs(amount_value)>9007199254740991 THEN RAISE EXCEPTION 'Ngày hoặc số tiền giao dịch không hợp lệ.'; END IF;
      running_value:=running_value+amount_value;
      IF running_value<>(e->>'balance')::numeric OR e->>'balance' IS NULL THEN RAISE EXCEPTION 'Dư nợ sau giao dịch % không khớp.',e->>'code'; END IF;
      purchase_id_value:=NULL; payment_id_value:=NULL;
      doc_id:='SRI-DOC-'||encode(sha256(convert_to(import_id_value||sid||e::text,'UTF8')),'hex');
      IF e->>'type'='purchase' AND amount_value>0 THEN
        IF EXISTS(SELECT 1 FROM public.purchases WHERE lower(code)=lower(e->>'code')) THEN RAISE EXCEPTION 'Mã phiếu % đã tồn tại.',e->>'code'; END IF;
        IF jsonb_typeof(e->'rows') IS DISTINCT FROM 'array' OR jsonb_array_length(e->'rows') NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'Phiếu mua thiếu dòng hàng.'; END IF;
        SELECT sum((v->>18)::numeric-COALESCE((v->>19)::numeric,0)+COALESCE((v->>20)::numeric,0)-COALESCE((v->>21)::numeric,0)+COALESCE((v->>22)::numeric,0)-COALESCE((v->>23)::numeric,0))
          INTO subtotal_value FROM jsonb_array_elements(e->'rows') v;
        IF subtotal_value IS NULL OR abs(subtotal_value-amount_value)>1 THEN RAISE EXCEPTION 'Tiền hàng/chiết khấu/thuế phiếu % không khớp.',e->>'code'; END IF;
        purchase_id_value:=doc_id;
        INSERT INTO public.purchases(id,code,supplier_id,purchase_date,status,total_amount,subtotal_amount,paid_amount,balance_due,payment_method,notes,created_by,source_report)
        VALUES(doc_id,e->>'code',sid,at_value,'completed',amount_value,amount_value,0,amount_value,'unknown','Nhập lịch sử từ báo cáo NCC; thanh toán theo NCC chưa phân bổ từng phiếu.',actor.auth_user_id::text,metadata||jsonb_build_object('entry',e));
        line_value:=0;
        FOR r IN SELECT value FROM jsonb_array_elements(e->'rows') LOOP
          line_value:=line_value+1;
          IF NULLIF(r->>11,'') IS NULL OR NULLIF(r->>12,'') IS NULL OR (r->>17)::numeric<=0 OR (r->>16)::numeric<0 OR (r->>18)::numeric<0 THEN RAISE EXCEPTION 'Dòng hàng không hợp lệ.'; END IF;
          INSERT INTO public.purchase_items(id,purchase_id,line_number,item_code,item_name,unit,quantity,unit_price,line_total)
          VALUES(doc_id||'-'||line_value,doc_id,line_value,r->>11,r->>12,COALESCE(r->>15,''),(r->>17)::numeric,(r->>16)::numeric,(r->>18)::numeric);
          count_items:=count_items+1;
        END LOOP;
        count_purchases:=count_purchases+1;
      ELSIF e->>'type'='payment' AND amount_value<0 THEN
        payment_id_value:=doc_id;
        INSERT INTO public.purchase_payments(id,supplier_id,amount,payment_method,status,notes,created_by,created_at,source_report)
        VALUES(doc_id,sid,-amount_value,'unknown','completed','Thanh toán lịch sử theo NCC; báo cáo không chỉ rõ phương thức chi và phiếu được phân bổ.',actor.auth_user_id::text,at_value,metadata||jsonb_build_object('entry',e));
        count_payments:=count_payments+1;
      ELSE RAISE EXCEPTION 'Loại hoặc dấu giao dịch không hợp lệ.';
      END IF;
      ledger_id:='SDL-'||replace(gen_random_uuid()::text,'-','');
      INSERT INTO public.supplier_debt_transactions(id,supplier_id,purchase_id,payment_id,transaction_type,amount_change,balance_after,notes,created_by,transaction_date,source_report)
      VALUES(ledger_id,sid,purchase_id_value,payment_id_value,CASE WHEN purchase_id_value IS NOT NULL THEN 'purchase' ELSE 'supplier_payment' END,amount_value,running_value,e->>'code',actor.auth_user_id::text,at_value,metadata||jsonb_build_object('entry',e));
    END LOOP;
    IF running_value<>closing_value THEN RAISE EXCEPTION 'Số cuối kỳ không khớp NCC %.',s.code; END IF;
    PERFORM public.p4_recompute_supplier(sid);
    INSERT INTO public.audit_logs(table_name,action,record_id,old_data,new_data,performed_by,created_at)
    VALUES('suppliers','IMPORT_REPORT',sid,to_jsonb(s),public.p4_supplier_response(sid)||metadata,actor.auth_user_id::text,now());
    count_suppliers:=count_suppliers+1;
  END LOOP;
  result_value:=jsonb_build_object('success',true,'importId',import_id_value,'suppliers',count_suppliers,'purchases',count_purchases,'payments',count_payments,'items',count_items);
  UPDATE public.supplier_report_imports SET result=result_value WHERE id=import_id_value;
  RETURN result_value;
END $$;
REVOKE ALL ON FUNCTION public.rpc_import_supplier_debt_report(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_import_supplier_debt_report(jsonb) TO authenticated;
ALTER FUNCTION public.rpc_import_supplier_debt_report(jsonb) SET statement_timeout='20s';

-- Imported records describe historical settlements without invoice allocation.
-- Prevent normal cancellation/payment RPCs from inventing that allocation.
DO $patch$
DECLARE def text; anchor text; spec text[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ARRAY['public.rpc_cancel_purchase(text,text)','purchase_row','SELECT * INTO STRICT purchase_row FROM public.purchases WHERE id = p_purchase_id FOR UPDATE;'],
    ARRAY['public.rpc_cancel_supplier_payment(text,text)','payment_row','SELECT * INTO STRICT payment_row FROM public.purchase_payments WHERE id = p_payment_id FOR UPDATE;'],
    ARRAY['public.rpc_record_supplier_payment(jsonb)','purchase_row','IF purchase_row.status <> ''completed'' THEN RAISE EXCEPTION ''Only completed purchases can be paid''; END IF;']
  ] LOOP
    SELECT pg_get_functiondef(spec[1]::regprocedure) INTO def; anchor:=spec[3];
    IF strpos(def,anchor)=0 THEN RAISE EXCEPTION '0127: RPC contract drift: %',spec[1]; END IF;
    EXECUTE replace(def,anchor,anchor||format(E'\n IF %s.source_report IS NOT NULL THEN RAISE EXCEPTION ''Phiếu lịch sử từ báo cáo NCC: cần đối chiếu công nợ NCC, không hủy/chi lại từng phiếu.''; END IF;',spec[2]));
  END LOOP;
  SELECT pg_get_functiondef('public.p4_purchase_response(text)'::regprocedure) INTO def;
  anchor:='''notes'', purchase.notes, ''createdBy'', purchase.created_by';
  IF strpos(def,anchor)=0 THEN RAISE EXCEPTION '0127: purchase response drift'; END IF;
  EXECUTE replace(def,anchor,anchor||', ''sourceReport'', purchase.source_report');
END $patch$;

CREATE FUNCTION public.rpc_supplier_debt_history(p_supplier_id text,p_offset integer DEFAULT 0,p_limit integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE actor public.profiles%ROWTYPE; result jsonb;
BEGIN
  actor:=public.require_authenticated_profile();
  IF actor.role NOT IN ('admin','accounting') THEN RAISE EXCEPTION 'Không có quyền xem công nợ NCC.' USING ERRCODE='42501'; END IF;
  IF p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Invalid offset'; END IF;
  SELECT jsonb_build_object('rows',COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.transaction_date DESC,t.id),'[]'::jsonb),
    'total',(SELECT count(*) FROM public.supplier_debt_transactions WHERE supplier_id=p_supplier_id)) INTO result
  FROM (SELECT * FROM public.supplier_debt_transactions WHERE supplier_id=p_supplier_id ORDER BY transaction_date DESC,id OFFSET p_offset LIMIT LEAST(GREATEST(COALESCE(p_limit,20),1),50)) t;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.rpc_supplier_debt_history(text,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_supplier_debt_history(text,integer,integer) TO authenticated;
INSERT INTO public.schema_migrations(version,description) VALUES('0127','Atomic reconciled supplier report import with historical purchases, unallocated payments, original rows and finance-only paged ledger');
NOTIFY pgrst,'reload schema';
COMMIT;
