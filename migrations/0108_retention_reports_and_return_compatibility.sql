BEGIN;

CREATE VIEW public.retention_statement_events WITH (security_invoker=true) AS
SELECT id,customer_id,transaction_date,order_id,debt_change,retention_company_id,'real'::text AS event_scope FROM public.customer_debt_transactions
UNION ALL
SELECT 'RETENTION-OPENING-'||customer_id,customer_id,cutoff,NULL::text,debt_opening,NULL::text,'global_opening'
FROM public.retention_customer_balances
UNION ALL
SELECT 'RETENTION-COMPANY-'||customer_id||':'||company_id,customer_id,cutoff,NULL::text,debt_opening,company_id,'company_opening'
FROM public.retention_customer_company_balances;
REVOKE ALL ON public.retention_statement_events FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.p108_merge_metrics(p_rows jsonb,p_changes jsonb,p_key text,p_fields text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
DECLARE result jsonb:='{}'; entry jsonb; prior jsonb; field text; key_value text;
BEGIN
  FOR entry IN SELECT value FROM jsonb_array_elements(COALESCE(p_rows,'[]')||COALESCE(p_changes,'[]')) LOOP
    key_value:=COALESCE(entry->>p_key,'unassigned'); prior:=COALESCE(result->key_value,'{}');
    FOREACH field IN ARRAY p_fields LOOP
      entry:=jsonb_set(entry,ARRAY[field],to_jsonb(COALESCE((prior->>field)::numeric,0)+COALESCE((entry->>field)::numeric,0)));
    END LOOP;
    result:=jsonb_set(result,ARRAY[key_value],prior||entry);
  END LOOP;
  RETURN COALESCE((SELECT jsonb_agg(value ORDER BY COALESCE(value->>p_key,'')) FROM jsonb_each(result)),'[]');
END $$;

CREATE FUNCTION public.p108_independent_items(p_filters jsonb) RETURNS TABLE(
  return_id text,customer_id text,customer_name text,employee_id text,employee_key text,employee_name text,
  company_id text,brand_id text,brand_name text,product_code text,product_name text,
  business_date timestamptz,quantity numeric,amount numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; start_at timestamptz; end_at timestamptz;
BEGIN
  actor:=public.require_authenticated_profile();
  start_at:=COALESCE(NULLIF(p_filters->>'start','')::timestamptz,date_trunc('month',now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok');
  end_at:=COALESCE(NULLIF(p_filters->>'end','')::timestamptz,now()+interval '1 day');
  RETURN QUERY SELECT r.id,r.customer_id,c.name,owners.employee_id,owners.customer_manager_id,owners.employee_name,
    COALESCE(i.revenue_company_id,b.company_id,owners.company_id),COALESCE(b.id,i.revenue_brand_id,original_item.brand_id,p.brand_id,p.brand,'unassigned'),
    COALESCE(b.name,p.brand,i.revenue_brand_id,'Chưa phân công'),COALESCE(i.variant_code_snapshot,p.code,i.product_id),
    i.product_name,COALESCE(r.return_date,r.created_at),i.quantity,i.subtotal
  FROM public.sales_returns r JOIN public.sales_return_items i ON i.return_id=r.id
  JOIN public.customers c ON c.id=r.customer_id
  JOIN public.independent_return_owners owners ON owners.return_id=r.id
  LEFT JOIN public.order_items original_item ON original_item.id=i.sale_item_id
  LEFT JOIN public.products p ON p.id=COALESCE(i.variant_id,i.product_id)
  LEFT JOIN LATERAL (SELECT brand.id,brand.name,brand.company_id FROM public.brands brand
    WHERE brand.id=COALESCE(i.revenue_brand_id,original_item.brand_id,p.brand_id)
      OR brand.name=COALESCE(i.revenue_brand_id,original_item.brand_id,p.brand) ORDER BY brand.id LIMIT 1) b ON true
  WHERE (r.source_kind='independent' OR owners.order_business_date<start_at OR owners.order_business_date>=end_at)
    AND r.status NOT IN('cancelled','canceled')
    AND COALESCE(r.return_date,r.created_at)>=start_at AND COALESCE(r.return_date,r.created_at)<end_at
    AND (actor.role<>'sale' OR c.managed_by IN(actor.id,actor.username,actor.auth_user_id::text))
    AND (NULLIF(NULLIF(p_filters->>'customer_id','all'),'') IS NULL OR p_filters->>'customer_id'=r.customer_id)
    AND (NULLIF(NULLIF(p_filters->>'company_id','all'),'') IS NULL OR p_filters->>'company_id'=COALESCE(i.revenue_company_id,b.company_id,owners.company_id))
    AND (NULLIF(NULLIF(p_filters->>'brand_id','all'),'') IS NULL OR p_filters->>'brand_id' IN(b.id,b.name,i.revenue_brand_id,p.brand_id,p.brand))
    AND (actor.role='sale' OR NULLIF(NULLIF(p_filters->>'salesperson_id','all'),'') IS NULL
      OR p_filters->>'salesperson_id' IN(owners.employee_id,owners.customer_manager_id));
END $$;

CREATE FUNCTION public.p108_dashboard_returns(p_result jsonb,p_filters jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rows_data jsonb; total numeric; item_quantity numeric; delta jsonb; field text; result jsonb:=p_result;
BEGIN
  SELECT COALESCE(jsonb_agg(to_jsonb(i)),'[]'),COALESCE(sum(amount),0),COALESCE(sum(quantity),0)
  INTO rows_data,total,item_quantity FROM public.p108_independent_items(p_filters) i;
  IF total=0 THEN RETURN result; END IF;
  result:=jsonb_set(result,'{summary}',COALESCE(result->'summary','{}')||jsonb_build_object(
    'returns',COALESCE((result#>>'{summary,returns}')::numeric,0)+total,
    'net_sales',COALESCE((result#>>'{summary,net_sales}')::numeric,0)-total,
    'sold_quantity',COALESCE((result#>>'{summary,sold_quantity}')::numeric,0)-item_quantity,
    'independent_return_quantity',item_quantity));
  IF COALESCE(p_filters->>'sales_mode','net')<>'gross' THEN
    FOREACH field IN ARRAY ARRAY['by_company','by_brand','by_salesperson','by_customer','series','top_skus'] LOOP
      IF field='series' THEN
        SELECT jsonb_agg(jsonb_build_object('date',date_key,'amount',-amount)) INTO delta
        FROM (SELECT to_char((x->>'business_date')::timestamptz AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD') date_key,
          sum((x->>'amount')::numeric) amount FROM jsonb_array_elements(rows_data) x GROUP BY 1) grouped;
      ELSIF field='top_skus' THEN
        SELECT jsonb_agg(jsonb_build_object('code',code,'name',name,'quantity',-quantity,'amount',-amount)) INTO delta
        FROM (SELECT x->>'product_code' code,max(x->>'product_name') name,sum((x->>'amount')::numeric) amount,sum((x->>'quantity')::numeric) quantity
          FROM jsonb_array_elements(rows_data) x GROUP BY 1) grouped;
      ELSE
        SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object('key',key_value,'name',display_name,'amount',-amount))) INTO delta
        FROM (SELECT CASE field WHEN 'by_company' THEN x->>'company_id' WHEN 'by_brand' THEN x->>'brand_id'
          WHEN 'by_salesperson' THEN x->>'employee_key' ELSE x->>'customer_id' END key_value,
          max(CASE field WHEN 'by_brand' THEN x->>'brand_name' WHEN 'by_customer' THEN x->>'customer_name'
            ELSE NULL END) display_name,sum((x->>'amount')::numeric) amount
          FROM jsonb_array_elements(rows_data) x GROUP BY 1) grouped;
      END IF;
      result:=jsonb_set(result,ARRAY[field],public.p108_merge_metrics(result->field,delta,
        CASE field WHEN 'series' THEN 'date' WHEN 'top_skus' THEN 'code' ELSE 'key' END,
        CASE WHEN field='top_skus' THEN ARRAY['amount','quantity'] ELSE ARRAY['amount'] END));
    END LOOP;
  END IF;
  SELECT jsonb_agg(jsonb_build_object('key',employee_key,'returns',amount,'net_sales',-amount)) INTO delta
  FROM (SELECT x->>'employee_key' employee_key,sum((x->>'amount')::numeric) amount FROM jsonb_array_elements(rows_data) x GROUP BY 1) grouped;
  result:=jsonb_set(result,'{kpi_by_employee}',public.p108_merge_metrics(result->'kpi_by_employee',delta,'key',
    ARRAY['returns','net_sales','gross_sales','collected','debt_issued']));
  RETURN result;
END $$;

CREATE FUNCTION public.p108_report_retention(p_result jsonb,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE boundary timestamptz; start_at timestamptz; end_at timestamptz;
BEGIN
  SELECT cutoff INTO boundary FROM public.retention_control WHERE id;
  IF boundary IS NULL THEN RETURN p_result; END IF;
  start_at:=COALESCE(NULLIF(p_input->>'start',''),p_result#>>'{metadata,start}',p_result#>>'{period,start}')::timestamptz;
  end_at:=COALESCE(NULLIF(p_input->>'end',''),p_result#>>'{metadata,end}',p_result#>>'{period,end}')::timestamptz;
  IF end_at<=boundary THEN RAISE EXCEPTION 'Kỳ báo cáo đã xóa. Dữ liệu chỉ còn từ %.',boundary USING ERRCODE='22023'; END IF;
  RETURN p_result||jsonb_build_object('retention',jsonb_build_object('cutoff',boundary,
    'partial_period',COALESCE(start_at<boundary,false),
    'company_opening_unallocated',false,
    'message',CASE WHEN start_at<boundary THEN 'Báo cáo chỉ gồm dữ liệu còn lưu từ mốc chuyển kỳ; không phải số liệu đầy đủ của kỳ cũ.'
      ELSE 'Chi tiết kỳ cũ đã xóa; các số dư khách hàng vẫn được bảo toàn.' END));
END $$;

-- Patch the current deployed definitions, not a stale copy of a report.
-- Every patch is guarded by exact anchors so schema drift aborts installation.
DO $migration$
DECLARE original text; patched text; block text; start_pos integer; end_pos integer;
BEGIN
  SELECT pg_get_functiondef('public.rpc_get_phase5_dashboard(jsonb)'::regprocedure) INTO original;
  IF original NOT LIKE '%RETURN result;%' THEN RAISE EXCEPTION '0108: dashboard contract has drifted'; END IF;
  patched:=replace(original,'RETURN result;','RETURN public.p108_report_retention(public.p108_dashboard_returns(result,p_filters),p_filters);');
  EXECUTE patched;

  SELECT pg_get_functiondef('public.rpc_get_phase5_report(jsonb)'::regprocedure) INTO original;
  IF original NOT LIKE '%JOIN public.orders sale ON sale.id = ret.sale_id%' THEN RAISE EXCEPTION '0108: returns report has drifted'; END IF;
  patched:=replace(original,'JOIN public.orders sale ON sale.id = ret.sale_id',
    'JOIN public.independent_return_owners sale ON sale.return_id = ret.id');
  patched:=replace(patched,'RETURN result;','RETURN public.p108_report_retention(result,p_input);');
  EXECUTE patched;

  SELECT pg_get_functiondef('public.rpc_get_employee_business_report(jsonb)'::regprocedure) INTO original;
  IF original NOT LIKE '%JOIN authorized_orders sale ON sale.id = ret.sale_id%' THEN RAISE EXCEPTION '0108: employee report has drifted'; END IF;
  patched:=replace(original,'JOIN authorized_orders sale ON sale.id = ret.sale_id',
    'JOIN public.independent_return_owners sale ON sale.return_id = ret.id');
  start_pos:=strpos(patched, '), return_rows AS ('); end_pos:=strpos(patched, '), ledger_rows AS (');
  IF start_pos=0 OR end_pos<=start_pos THEN RAISE EXCEPTION '0108: return report scope not found'; END IF;
  block:=substring(patched FROM start_pos FOR end_pos-start_pos);
  block:=replace(block,'SELECT ret.*, sale.employee_id, sale.employee_name',
    'SELECT ret.*, sale.employee_id, sale.employee_name,
      (sale.order_business_date IS NULL OR sale.order_business_date<start_at OR sale.order_business_date>=end_at) AS retention_separate_return');
  block:=replace(block, 'WHERE ret.status NOT IN',
    'WHERE (actor.role <> ''sale'' OR sale.customer_manager_id IN(actor.id,actor.username,actor.auth_user_id::text))
      AND (requested_company IS NULL OR sale.company_id=requested_company) AND ret.status NOT IN');
  patched:=overlay(patched PLACING block FROM start_pos FOR end_pos-start_pos);
  patched:=replace(patched, 'count(*) AS return_count,', 'count(*) AS return_count,
      COALESCE(sum(COALESCE(NULLIF(total_refund,0),total_return_amount,0)) FILTER(WHERE retention_separate_return),0) AS independent_amount,
      COALESCE(sum((SELECT sum(i.quantity) FROM public.sales_return_items i WHERE i.return_id=ret.id)) FILTER(WHERE retention_separate_return),0) AS independent_quantity,');
  patched:=replace(patched,'COALESCE(orders.net_sales, 0)',
    '(COALESCE(orders.net_sales,0)-COALESCE(returns.independent_amount,0))');
  patched:=replace(patched,'COALESCE(orders.sold_quantity, 0)',
    '(COALESCE(orders.sold_quantity,0)-COALESCE(returns.independent_quantity,0))');
  patched:=replace(patched,'''YYYY-MM-DD''), 0, 0,'||chr(10)||'        COALESCE(NULLIF(total_refund, 0), total_return_amount, 0)',
    '''YYYY-MM-DD''), 0, CASE WHEN retention_separate_return THEN -COALESCE(NULLIF(total_refund,0),total_return_amount,0) ELSE 0 END,'||chr(10)||'        COALESCE(NULLIF(total_refund, 0), total_return_amount, 0)');
  start_pos:=strpos(patched, '), ledger_to_end AS ('); end_pos:=strpos(patched, '), cashbook_rows AS (');
  IF start_pos=0 OR end_pos<=start_pos THEN RAISE EXCEPTION '0108: debt report opening scope not found'; END IF;
  block:=substring(patched FROM start_pos FOR end_pos-start_pos);
  block:=replace(block,'FROM public.customer_debt_transactions ledger','FROM public.retention_statement_events ledger');
  block:=replace(block,'WHERE ledger.transaction_date < end_at',
    'WHERE ledger.transaction_date < end_at
      AND ((requested_company IS NULL AND ledger.event_scope<>''company_opening'')
        OR (requested_company IS NOT NULL AND ledger.event_scope<>''global_opening''))');
  patched:=overlay(patched PLACING block FROM start_pos FOR end_pos-start_pos);
  patched:=replace(patched,'AND (requested_company IS NULL OR EXISTS ('||chr(10)||'        SELECT 1 FROM public.orders sale WHERE sale.id = ledger.order_id AND sale.company_id = requested_company',
    'AND (requested_company IS NULL OR ledger.retention_company_id=requested_company OR EXISTS ('||chr(10)||'        SELECT 1 FROM public.orders sale WHERE sale.id = ledger.order_id AND sale.company_id = requested_company');
  patched:=replace(patched,'RETURN result;','RETURN public.p108_report_retention(result,p_input);');
  EXECUTE patched;
END $migration$;

CREATE FUNCTION public.rpc_list_independent_returns(p_input jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; rows_data jsonb; total bigint;
  page_offset integer:=greatest(0,least(COALESCE((p_input->>'offset')::integer,0),100000));
  page_limit integer:=greatest(1,least(COALESCE((p_input->>'limit')::integer,25),50));
BEGIN
  actor:=public.require_authenticated_profile();
  IF actor.role NOT IN('admin','accounting') THEN RAISE EXCEPTION 'Chỉ Admin hoặc kế toán được xem phiếu trả độc lập.' USING ERRCODE='42501'; END IF;
  SELECT count(*) INTO total FROM public.sales_returns r WHERE source_kind='independent'
    AND (NULLIF(p_input->>'customerId','') IS NULL OR r.customer_id=p_input->>'customerId');
  SELECT COALESCE(jsonb_agg(public.p3_sales_return_response(r.id)||jsonb_build_object('customer_name',c.name)
    ORDER BY COALESCE(r.return_date,r.created_at) DESC,r.id DESC),'[]') INTO rows_data
  FROM (SELECT * FROM public.sales_returns WHERE source_kind='independent'
    AND (NULLIF(p_input->>'customerId','') IS NULL OR customer_id=p_input->>'customerId')
    ORDER BY COALESCE(return_date,created_at) DESC,id DESC LIMIT page_limit OFFSET page_offset) r
  JOIN public.customers c ON c.id=r.customer_id;
  RETURN jsonb_build_object('rows',rows_data,'total',total,'offset',page_offset,'limit',page_limit);
END $$;
REVOKE ALL ON FUNCTION public.rpc_list_independent_returns(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_list_independent_returns(jsonb) TO authenticated;

-- Detached legacy returns retain their original debt/cash split. Reversing
-- them must undo that exact split, not grant or withdraw the total twice.
DO $migration$
DECLARE original text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_cancel_sales_return(text,text)'::regprocedure) INTO original;
  original:=replace(original,'total numeric;', 'total numeric; refund_entry public.cashbook_transactions%ROWTYPE;');
  original:=replace(original,
    'IF COALESCE(ret.refund_amount, 0) <> 0 OR ret.refund_cashbook_transaction_id IS NOT NULL THEN',
    'IF COALESCE(ret.refund_amount,0)<>0 AND ret.refund_cashbook_transaction_id IS NULL THEN');
  original:=replace(original, '  IF ret.stock_applied THEN',
    '  IF ret.refund_cashbook_transaction_id IS NOT NULL THEN
      SELECT * INTO STRICT refund_entry FROM public.cashbook_transactions WHERE id=ret.refund_cashbook_transaction_id FOR UPDATE;
      IF refund_entry.status NOT IN(''cancelled'',''canceled'') THEN
        UPDATE public.cashbook_transactions SET status=''cancelled'',cancelled_at=now(),cancelled_by=actor.auth_user_id::text,
          cancellation_reason=''Hủy phiếu trả ''||ret.id,updated_by=actor.auth_user_id::text WHERE id=refund_entry.id;
        INSERT INTO public.cashbook_transactions(id,date,transaction_date,type,transaction_type,direction,category,partner,
          customer_id,sales_return_id,value,method,payment_method,accounting,status,creator,created_by,note,starred,reversal_of_id)
        VALUES(''VOID-''||refund_entry.id,now(),now(),''thu'',''sales_return_refund_reversal'',''in'',''Đảo hoàn tiền trả hàng'',
          refund_entry.partner,ret.customer_id,ret.id,refund_entry.value,refund_entry.method,refund_entry.payment_method,false,
          ''cancelled'',actor.display_name,actor.auth_user_id::text,''Đảo hoàn tiền ''||ret.id,false,refund_entry.id);
      END IF;
    END IF;
    IF ret.stock_applied THEN');
  EXECUTE original;
END $migration$;

-- A changed archive is not silently truncated by the historical special case.
DO $migration$
DECLARE original text;
BEGIN
  SELECT pg_get_functiondef('public.p107_preview(boolean)'::regprocedure) INTO original;
  original:=replace(original, 'IF p_include_archive AND to_regclass',
    'IF p_include_archive AND EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace
      WHERE n.nspname NOT LIKE ''pg_%'' AND f.proname NOT LIKE ''p107_%''
        AND f.proname NOT LIKE ''rpc_%retention%'' AND f.prosrc ILIKE ''%activity_logs_archive_pre_20260804%'') THEN
      blockers:=blockers||jsonb_build_array(''Một hàm khác đang tham chiếu archive; cần kiểm tra trước khi dọn.'');
    END IF;
    IF p_include_archive AND to_regclass');
  EXECUTE original;
END $migration$;

DO $migration$
DECLARE entry record;
BEGIN
  FOR entry IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'p108_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',entry.signature);
  END LOOP;
END $migration$;
INSERT INTO public.schema_migrations(version,description)
VALUES ('0108','Independent returns in dashboard/reports and retained debt statement openings') ON CONFLICT DO NOTHING;
UPDATE public.retention_control SET expected_trigger_hash=public.p107_trigger_fingerprint() WHERE id;
NOTIFY pgrst,'reload schema';
COMMIT;
