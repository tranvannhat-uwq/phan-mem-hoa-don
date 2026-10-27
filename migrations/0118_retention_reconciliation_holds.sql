BEGIN;
-- Additive installation only. This migration never prepares or executes a purge.
DO $preflight$
DECLARE entry record;
BEGIN
  IF (SELECT count(*) FROM public.schema_migrations WHERE version IN('0114','0115','0116','0117'))<>4 THEN
    RAISE EXCEPTION '0118 requires the reviewed 0114-0117 schema first';
  END IF;
  FOR entry IN SELECT * FROM (VALUES
    ('p107_plan(timestamptz)','a1943182edc7b89c0e7191f6f8479a4f'),
    ('p107_preview(boolean)','f3b93d2162d6efb6c313ed574b30a181'),
    ('p107_snapshot_tables(boolean)','c76d904b34e9d6c19d2ec86c3316ea45'),
    ('p114_preserve_support(timestamptz)','27ea92ef88857c2086b5b120414f07a7'),
    ('rpc_execute_monthly_retention(uuid,text,text)','caddccb0559ddfb2ee1306e835375389')
  ) contracts(signature,body_hash) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.'||entry.signature)
      AND md5(replace(prosrc,chr(13),''))=entry.body_hash) THEN
      RAISE EXCEPTION '0118: unreviewed retention function %; installation stopped',entry.signature;
    END IF;
  END LOOP;
END $preflight$;
CREATE TABLE public.retention_review_orders (
  order_id text PRIMARY KEY REFERENCES public.orders(id) ON DELETE RESTRICT,
  reasons jsonb NOT NULL CHECK(jsonb_typeof(reasons)='array'),
  source_snapshot jsonb NOT NULL,
  cutoff timestamptz NOT NULL,
  kept_at timestamptz NOT NULL DEFAULT now(),
  kept_by uuid NOT NULL
);
ALTER TABLE public.retention_review_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.retention_review_orders FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.p118_row_key(p_row jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT COALESCE(p_row->>'id',CASE WHEN p_row->>'order_id' IS NOT NULL
    THEN jsonb_build_array(p_row->>'order_id',p_row->>'product_id')::text END,p_row->>'ledger_id',p_row->>'period')
$$;

CREATE FUNCTION public.p118_support_issues(p_cutoff timestamptz)
RETURNS TABLE(order_id text,reasons jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT i.order_id,jsonb_agg(DISTINCT reason ORDER BY reason)
  FROM public.p114_source_lines() s JOIN public.order_items i
    ON s.source_key=encode(sha256(convert_to(i.id,'UTF8')),'hex')
  CROSS JOIN LATERAL (SELECT reason FROM (VALUES
    (CASE WHEN s.customer_id IS NULL THEN 'Chưa liên kết khách hàng' END),
    (CASE WHEN s.quantity IS NULL OR s.quantity<=0 OR s.quantity::text IN('NaN','Infinity','-Infinity') THEN 'Số lượng hàng cấp không hợp lệ' END),
    (CASE WHEN s.returned_quantity IS NULL OR s.returned_quantity<0 OR s.returned_quantity>s.quantity
      OR s.returned_quantity::text IN('NaN','Infinity','-Infinity') THEN 'Số lượng trả hàng không hợp lệ' END),
    (CASE WHEN s.returned_quantity<COALESCE((SELECT sum(ri.quantity) FROM public.sales_return_items ri
      JOIN public.sales_returns r ON r.id=ri.return_id WHERE ri.sale_item_id=i.id AND r.status NOT IN('cancelled','canceled')),0)
      THEN 'Số lượng đã trả chưa khớp phiếu trả' END)
  ) warnings(reason) WHERE reason IS NOT NULL) warning
  WHERE s.business_date<p_cutoff GROUP BY i.order_id
$$;

-- Follow document-to-document links in BOTH directions. Catalog/customer/profile
-- parents are deliberately outside this graph: a shared customer is not a shared
-- receipt. Include legacy pointer columns even where an old schema has no FK.
CREATE FUNCTION public.p118_kept_rows() RETURNS TABLE(table_name text,row_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE tables text[]; edge_sql text:=''; edge text; joins text; ref record; pointer record;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.retention_review_orders) THEN RETURN; END IF;
  IF public.p107_is_executing() AND to_regclass('pg_temp._retention_kept') IS NOT NULL THEN
    RETURN QUERY SELECT k.table_name,k.row_id FROM pg_temp._retention_kept k; RETURN;
  END IF;
  SELECT array_agg(name) INTO tables FROM unnest(ARRAY[
    'orders','draft_orders','order_items','sales_returns','sales_return_items','cashbook_transactions','payments',
    'customer_debt_transactions','order_amendments','customer_debt_amendment_voids','customer_debt_history_suppressions',
    'purchases','purchase_items','purchase_payments','supplier_debt_transactions','commission_transactions',
    'payroll_entries','payroll_adjustments','payroll_periods','inventory_documents','inventory_movements',
    'inventory_order_positions','inventory_pending_orders','inventory_sync_outbox',
    'audit_logs','activity_logs','activity_logs_archive_pre_20260804']) name
    WHERE to_regclass('public.'||name) IS NOT NULL;
  FOR ref IN SELECT fk.oid,fk.conkey,fk.confkey,child.relname child_table,parent.relname parent_table,
      fk.conrelid,fk.confrelid
    FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_class parent ON parent.oid=fk.confrelid
    WHERE fk.contype='f' AND child.relnamespace='public'::regnamespace AND parent.relnamespace='public'::regnamespace
      AND child.relname=ANY(tables) AND parent.relname=ANY(tables) LOOP
    SELECT string_agg(format('c.%I=p.%I',c.attname,p.attname),' AND ') INTO joins
      FROM unnest(ref.conkey,ref.confkey) keys(cnum,pnum)
      JOIN pg_attribute c ON c.attrelid=ref.conrelid AND c.attnum=keys.cnum
      JOIN pg_attribute p ON p.attrelid=ref.confrelid AND p.attnum=keys.pnum;
    edge:=format('SELECT %L::text,public.p118_row_key(to_jsonb(c)),%L::text,public.p118_row_key(to_jsonb(p)) FROM public.%I c JOIN public.%I p ON %s',
      ref.child_table,ref.parent_table,ref.child_table,ref.parent_table,joins);
    edge_sql:=concat_ws(' UNION ALL ',NULLIF(edge_sql,''),edge);
  END LOOP;
  FOR pointer IN SELECT c.table_name child_table,c.column_name child_column,p.parent_table,p.parent_column
    FROM information_schema.columns c CROSS JOIN LATERAL (SELECT * FROM (VALUES
      ('order_id','orders','id'),('sale_id','orders','id'),('order_item_id','order_items','id'),('sale_item_id','order_items','id'),
      ('return_id','sales_returns','id'),('sales_return_id','sales_returns','id'),
      ('cashbook_transaction_id','cashbook_transactions','id'),('refund_cashbook_transaction_id','cashbook_transactions','id'),
      ('purchase_id','purchases','id'),('purchase_payment_id','purchase_payments','id'),
      ('target_amendment_id','order_amendments','id'),('reversal_amendment_id','order_amendments','id'),
      ('ledger_id','customer_debt_transactions','id'),('amends_ledger_id','customer_debt_transactions','id'),
      ('document_id','inventory_documents','id'),('inventory_document_id','inventory_documents','id'),
      ('salary_period','payroll_periods','period')
    ) links(child_column,parent_table,parent_column) WHERE links.child_column=c.column_name
    UNION ALL SELECT c.column_name,c.table_name,'id' WHERE c.column_name='reversal_of_id'
    UNION ALL SELECT 'payment_id',CASE WHEN c.table_name='supplier_debt_transactions' THEN 'purchase_payments' ELSE 'payments' END,'id'
      WHERE c.column_name='payment_id'
    UNION ALL SELECT c.column_name,'orders','id' WHERE c.column_name IN('record_id','target_id')
      AND c.table_name IN('audit_logs','activity_logs','activity_logs_archive_pre_20260804')) p
    WHERE c.table_schema='public' AND c.table_name=ANY(tables) AND p.parent_table=ANY(tables)
      AND EXISTS(SELECT 1 FROM information_schema.columns pc WHERE pc.table_schema='public'
        AND pc.table_name=p.parent_table AND pc.column_name=p.parent_column) LOOP
    edge:=format('SELECT %L::text,public.p118_row_key(to_jsonb(c)),%L::text,public.p118_row_key(to_jsonb(p)) FROM public.%I c JOIN public.%I p ON c.%I::text=p.%I::text',
      pointer.child_table,pointer.parent_table,pointer.child_table,pointer.parent_table,pointer.child_column,pointer.parent_column);
    edge_sql:=concat_ws(' UNION ALL ',NULLIF(edge_sql,''),edge);
  END LOOP;
  IF edge_sql='' THEN edge_sql:='SELECT NULL::text,NULL::text,NULL::text,NULL::text WHERE false'; END IF;
  RETURN QUERY EXECUTE 'WITH RECURSIVE edges(ft,fi,tt,ti) AS MATERIALIZED ('||edge_sql||'),
    links AS MATERIALIZED (SELECT * FROM edges UNION SELECT tt,ti,ft,fi FROM edges),
    kept(t,i) AS (SELECT ''orders''::text,order_id FROM public.retention_review_orders
      UNION SELECT l.tt,l.ti FROM kept k JOIN links l ON l.ft=k.t AND l.fi=k.i WHERE l.ti IS NOT NULL)
    SELECT t,i FROM kept';
END $$;

ALTER FUNCTION public.p107_plan(timestamptz) RENAME TO p118_original_plan;
CREATE FUNCTION public.p107_plan(p_cutoff timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH kept AS MATERIALIZED (SELECT * FROM public.p118_kept_rows())
  SELECT jsonb_object_agg(entry.key,COALESCE((SELECT jsonb_agg(id ORDER BY id)
    FROM jsonb_array_elements_text(entry.value) ids(id) WHERE NOT EXISTS(SELECT 1 FROM kept k WHERE k.row_id=ids.id
      AND k.table_name=CASE entry.key WHEN 'drafts' THEN 'draft_orders' WHEN 'cashbook' THEN 'cashbook_transactions'
        WHEN 'returns' THEN 'sales_returns' WHEN 'supplier_payments' THEN 'purchase_payments'
        WHEN 'ledger' THEN 'customer_debt_transactions' ELSE entry.key END)),'[]'::jsonb))
  FROM jsonb_each(public.p118_original_plan(p_cutoff)) entry
$$;

CREATE FUNCTION public.p118_purge_support_lines() RETURNS TABLE(
  source_key text,customer_id text,product_id text,product_code text,product_name text,unit_name text,
  brand_id text,brand_name text,company_id text,company_name text,quantity numeric,returned_quantity numeric,
  business_date timestamptz,order_cancelled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH kept AS MATERIALIZED (SELECT row_id FROM public.p118_kept_rows() WHERE table_name='order_items')
  SELECT s.* FROM public.p114_source_lines() s
    WHERE NOT EXISTS(SELECT 1 FROM kept k WHERE s.source_key=encode(sha256(convert_to(k.row_id,'UTF8')),'hex'))
$$;

CREATE FUNCTION public.p118_is_kept(p_table text,p_row jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT public.p107_is_executing() OR to_regclass('pg_temp._retention_kept') IS NULL THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM pg_temp._retention_kept k WHERE k.table_name=p_table AND k.row_id=public.p118_row_key(p_row));
END $$;

CREATE FUNCTION public.p118_cache_kept() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target text;
BEGIN
  IF NOT public.p107_is_executing() THEN RAISE EXCEPTION 'Review preservation requires the bound retention transaction' USING ERRCODE='42501'; END IF;
  DROP TABLE IF EXISTS pg_temp._retention_kept_seed,pg_temp._retention_kept;
  -- Compute before creating the cache: the read helper must not see a partial cache.
  CREATE TEMP TABLE _retention_kept_seed ON COMMIT DROP AS SELECT * FROM public.p118_kept_rows();
  CREATE TEMP TABLE _retention_kept(table_name text,row_id text,payload jsonb,PRIMARY KEY(table_name,row_id)) ON COMMIT DROP;
  FOR target IN SELECT DISTINCT table_name FROM _retention_kept_seed LOOP
    EXECUTE format('INSERT INTO pg_temp._retention_kept SELECT $1,public.p118_row_key(to_jsonb(t)),to_jsonb(t)
      FROM public.%I t JOIN pg_temp._retention_kept_seed k ON k.table_name=$1 AND k.row_id=public.p118_row_key(to_jsonb(t))',target) USING target;
  END LOOP;
END $$;

CREATE FUNCTION public.p118_assert_kept() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target text; changed boolean;
BEGIN
  IF NOT public.p107_is_executing() THEN RAISE EXCEPTION 'Review verification requires the bound retention transaction' USING ERRCODE='42501'; END IF;
  FOR target IN SELECT DISTINCT table_name FROM pg_temp._retention_kept LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM pg_temp._retention_kept k LEFT JOIN public.%I t
      ON k.row_id=public.p118_row_key(to_jsonb(t)) WHERE k.table_name=$1 AND to_jsonb(t) IS DISTINCT FROM k.payload)',target)
      INTO changed USING target;
    IF changed THEN RAISE EXCEPTION 'Đã hủy dọn: chứng từ giữ để đối soát bị thay đổi (%).',target; END IF;
  END LOOP;
END $$;

-- Preserve the existing validation and reconciliation, changing only the target
-- set and the explicitly date-based ancillary cleanup. Final byte-for-byte row
-- checks abort the WHOLE transaction if a future cleanup forgets this hold set.
DO $migration$
DECLARE original text; anchor text; replacement text; target text;
BEGIN
  SELECT pg_get_functiondef('public.p107_snapshot_tables(boolean)'::regprocedure) INTO original;
  anchor:='''retention_retired_requests'',''dealer_support_control''';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected snapshot contract'; END IF;
  EXECUTE replace(original,anchor,'''retention_retired_requests'',''retention_review_orders'',''dealer_support_control''');

  SELECT pg_get_functiondef('public.p107_preview(boolean)'::regprocedure) INTO original;
  IF strpos(original,'public.p114_source_lines()')=0 THEN RAISE EXCEPTION '0118: unexpected support preview contract'; END IF;
  original:=replace(original,'public.p114_source_lines()','public.p118_purge_support_lines()');
  anchor:='AND f.prosrc ILIKE ''%activity_logs_archive_pre_20260804%''';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected archive function guard'; END IF;
  SELECT anchor||' AND NOT (f.oid=''public.p118_kept_rows()''::regprocedure AND md5(replace(f.prosrc,chr(13),''''))='
    ||quote_literal(md5(replace(prosrc,chr(13),'')))||')' INTO replacement
    FROM pg_proc WHERE oid='public.p118_kept_rows()'::regprocedure;
  original:=replace(original,anchor,replacement);
  anchor:='''database_bytes'',pg_database_size(current_database())';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected preview response contract'; END IF;
  replacement:=$patch$'review_pending',(SELECT count(*) FROM public.p118_support_issues(boundary) i
      WHERE NOT EXISTS(SELECT 1 FROM public.retention_review_orders h WHERE h.order_id=i.order_id)),
    'review_held',(SELECT count(*) FROM public.retention_review_orders),
    'review_related',(SELECT COALESCE(jsonb_object_agg(kept.table_name,kept.n),'{}') FROM
      (SELECT table_name,count(*) n FROM public.p118_kept_rows() GROUP BY table_name) kept),
    $patch$||anchor;
  EXECUTE replace(original,anchor,replacement);

  SELECT pg_get_functiondef('public.p114_preserve_support(timestamptz)'::regprocedure) INTO original;
  IF strpos(original,'public.p114_source_lines()')=0 THEN RAISE EXCEPTION '0118: unexpected support preservation contract'; END IF;
  EXECUTE replace(original,'public.p114_source_lines()','public.p118_purge_support_lines()');

  SELECT pg_get_functiondef('public.rpc_execute_monthly_retention(uuid,text,text)'::regprocedure) INTO original;
  anchor:='CREATE TEMP TABLE _retention_ids(kind text,id text,PRIMARY KEY(kind,id)) ON COMMIT DROP;';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected purge cache contract'; END IF;
  original:=replace(original,anchor,'PERFORM public.p118_cache_kept();'||chr(10)||'  '||anchor);
  anchor:='DELETE FROM public.supplier_debt_transactions WHERE payment_id IN';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected supplier ledger cleanup'; END IF;
  original:=replace(original,anchor,'DELETE FROM public.supplier_debt_transactions WHERE NOT public.p118_is_kept(''supplier_debt_transactions'',to_jsonb(supplier_debt_transactions)) AND (payment_id IN');
  anchor:='OR (transaction_date<job.cutoff AND (purchase_id IS NULL OR purchase_id IN(SELECT id FROM _retention_ids WHERE kind=''purchases'')));';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected supplier ledger boundary'; END IF;
  original:=replace(original,anchor,replace(anchor,';',' );'));
  anchor:='DELETE FROM public.commission_transactions WHERE salary_period<';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected commission cleanup'; END IF;
  original:=replace(original,anchor,'DELETE FROM public.commission_transactions WHERE NOT public.p118_is_kept(''commission_transactions'',to_jsonb(commission_transactions)) AND (salary_period<');
  anchor:='OR cashbook_transaction_id IN(SELECT id FROM _retention_ids WHERE kind=''cashbook'');';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected commission cashbook boundary'; END IF;
  original:=replace(original,anchor,replace(anchor,';',' );'));
  FOREACH target IN ARRAY ARRAY['payroll_entries','payroll_adjustments','payroll_periods'] LOOP
    anchor:='DELETE FROM public.'||target||' WHERE period<';
    IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected payroll cleanup %',target; END IF;
    original:=replace(original,anchor,'DELETE FROM public.'||target||' WHERE NOT public.p118_is_kept('||quote_literal(target)||',to_jsonb('||target||')) AND period<');
  END LOOP;
  anchor:='DELETE FROM public.inventory_movements WHERE created_at<job.cutoff OR order_id IN(SELECT id FROM _retention_ids WHERE kind=''orders'');';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected inventory cleanup'; END IF;
  original:=replace(original,anchor,'DELETE FROM public.inventory_movements WHERE NOT public.p118_is_kept(''inventory_movements'',to_jsonb(inventory_movements)) AND (created_at<job.cutoff OR order_id IN(SELECT id FROM _retention_ids WHERE kind=''orders''));');
  anchor:='public.inventory_documents d WHERE d.created_at<job.cutoff';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected inventory document cleanup'; END IF;
  original:=replace(original,anchor,anchor||' AND NOT public.p118_is_kept(''inventory_documents'',to_jsonb(d))');
  anchor:='UPDATE public.audit_logs SET old_data=';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected audit scrub'; END IF;
  original:=replace(original,'WHERE old_data IS NOT NULL OR new_data IS NOT NULL;',
    'WHERE NOT public.p118_is_kept(''audit_logs'',to_jsonb(audit_logs)) AND (old_data IS NOT NULL OR new_data IS NOT NULL);');
  anchor:='metadata=public.p107_scrub_history_json(metadata);';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected activity scrub'; END IF;
  original:=replace(original,anchor,'metadata=public.p107_scrub_history_json(metadata) WHERE NOT public.p118_is_kept(''activity_logs'',to_jsonb(activity_logs));');
  anchor:='DELETE FROM public.audit_logs log WHERE log.created_at<job.cutoff';
  original:=replace(original,anchor,'DELETE FROM public.audit_logs log WHERE NOT public.p118_is_kept(''audit_logs'',to_jsonb(log)) AND (log.created_at<job.cutoff');
  anchor:='OR public.p107_payload_references_removed(log.old_data) OR public.p107_payload_references_removed(log.new_data);';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected audit deletion'; END IF;
  original:=replace(original,anchor,replace(anchor,';',' );'));
  anchor:='DELETE FROM public.activity_logs log WHERE log.created_at<job.cutoff';
  original:=replace(original,anchor,'DELETE FROM public.activity_logs log WHERE NOT public.p118_is_kept(''activity_logs'',to_jsonb(log)) AND (log.created_at<job.cutoff');
  anchor:='OR public.p107_payload_references_removed(log.changes) OR public.p107_payload_references_removed(log.metadata);';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected activity deletion'; END IF;
  original:=replace(original,anchor,replace(anchor,';',' );'));
  anchor:='TRUNCATE ONLY public.activity_logs_archive_pre_20260804 CONTINUE IDENTITY RESTRICT;';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected archive cleanup'; END IF;
  original:=replace(original,anchor,'DELETE FROM public.activity_logs_archive_pre_20260804 log WHERE NOT public.p118_is_kept(''activity_logs_archive_pre_20260804'',to_jsonb(log));');
  anchor:='-- Force deferred financial constraints BEFORE marking the job completed.';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0118: unexpected final reconciliation'; END IF;
  original:=replace(original,anchor,'PERFORM public.p118_assert_kept();'||chr(10)||'  '||anchor);
  original:=replace(original,'''counts'',preview->''counts'',''customers_preserved''',
    '''counts'',preview->''counts'',''review_held'',preview->''review_held'',''review_related'',preview->''review_related'',''customers_preserved''');
  EXECUTE original;
END $migration$;

CREATE FUNCTION public.rpc_hold_retention_warnings(p_include_archive boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; boundary timestamptz:=public.p107_cutoff(); added integer;
BEGIN
  actor:=public.p107_require_admin();
  PERFORM set_config('lock_timeout','3s',true);
  PERFORM public.p107_lock_scope(p_include_archive);
  INSERT INTO public.retention_review_orders(order_id,reasons,source_snapshot,cutoff,kept_by)
    SELECT i.order_id,i.reasons,jsonb_build_object('order',to_jsonb(o),'items',
      (SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id),'[]') FROM public.order_items item WHERE item.order_id=o.id)),boundary,actor.auth_user_id
    FROM public.p118_support_issues(boundary) i JOIN public.orders o ON o.id=i.order_id ON CONFLICT(order_id) DO NOTHING;
  GET DIAGNOSTICS added=ROW_COUNT;
  RETURN jsonb_build_object('added',added,'preview',public.p107_preview(p_include_archive));
END $$;

CREATE FUNCTION public.rpc_retention_review_orders(p_offset integer DEFAULT 0,p_limit integer DEFAULT 25) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; rows_data jsonb; total bigint;
BEGIN
  actor:=public.require_authenticated_profile();
  IF actor.role NOT IN('admin','accounting') THEN RAISE EXCEPTION 'Chỉ Admin hoặc kế toán được xem chứng từ cần đối soát.' USING ERRCODE='42501'; END IF;
  IF p_offset IS NULL OR p_offset<0 OR p_offset>100000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Phân trang không hợp lệ.'; END IF;
  SELECT count(*) INTO total FROM public.retention_review_orders;
  SELECT COALESCE(jsonb_agg(to_jsonb(held) ORDER BY kept_at DESC,order_id),'[]') INTO rows_data FROM (
    SELECT h.order_id,h.reasons,h.cutoff,h.kept_at,h.source_snapshot,
      to_jsonb(o) AS current_order,(SELECT COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.id),'[]')
        FROM public.order_items item WHERE item.order_id=o.id) AS current_items
    FROM public.retention_review_orders h JOIN public.orders o ON o.id=h.order_id
    ORDER BY h.kept_at DESC,h.order_id LIMIT p_limit OFFSET p_offset) held;
  RETURN jsonb_build_object('rows',rows_data,'total',total,'offset',p_offset,'limit',p_limit);
END $$;

DO $permissions$
DECLARE entry record;
BEGIN
  FOR entry IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'p118_%' OR p.proname IN('rpc_hold_retention_warnings','rpc_retention_review_orders')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',entry.signature);
  END LOOP;
END $permissions$;
GRANT EXECUTE ON FUNCTION public.rpc_hold_retention_warnings(boolean),public.rpc_retention_review_orders(integer,integer) TO authenticated;
REVOKE ALL ON FUNCTION public.p107_plan(timestamptz) FROM PUBLIC,anon,authenticated;
ALTER FUNCTION public.rpc_hold_retention_warnings(boolean) SET statement_timeout='60s';
INSERT INTO public.schema_migrations(version,description) VALUES ('0118','Keep warning documents and their connected records unchanged for later accounting reconciliation');
NOTIFY pgrst,'reload schema';
COMMIT;
