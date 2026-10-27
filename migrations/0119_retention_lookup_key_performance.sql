BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
-- No document is held, backed up or deleted by this installation.
DO $preflight$
DECLARE entry record;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version='0118') THEN RAISE EXCEPTION '0119 requires 0118'; END IF;
  FOR entry IN SELECT * FROM (VALUES
    ('p118_kept_rows()','c54105b65993e7fd05311e121212b987'),
    ('p118_cache_kept()','bb4799a73ae29122de51384bdfe0ed28'),
    ('p118_assert_kept()','43fc74d28f426ef953755251d457f96c'),
    ('p107_preview(boolean)','823d07d1a286143549c770b5bc9cbcba'),
    ('rpc_execute_monthly_retention(uuid,text,text)','c264fecda78dca327179c645d0d1f951')
  ) contracts(signature,body_hash) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid=to_regprocedure('public.'||entry.signature)
      AND md5(replace(prosrc,chr(13),''))=entry.body_hash) THEN
      RAISE EXCEPTION '0119: unreviewed function %; installation stopped',entry.signature;
    END IF;
  END LOOP;
END $preflight$;

-- Compute exactly the existing key without converting every field of a row
-- (including large, toasted audit JSON) to JSONB just to extract its ID.
CREATE FUNCTION public.p119_row_key_sql(p_table text,p_alias text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE columns text[]; id_required boolean; parts text[]:='{}'; part text;
BEGIN
  SELECT array_agg(attname),bool_or(attname='id' AND attnotnull) INTO columns,id_required
    FROM pg_attribute WHERE attrelid=to_regclass('public.'||quote_ident(p_table)) AND attnum>0 AND NOT attisdropped;
  IF columns IS NULL THEN RAISE EXCEPTION 'Unsupported document table: %',p_table; END IF;
  IF id_required THEN RETURN format('%I.id::text',p_alias); END IF;
  IF 'id'=ANY(columns) THEN parts:=array_append(parts,format('%I.id::text',p_alias)); END IF;
  IF 'order_id'=ANY(columns) THEN
    part:=CASE WHEN 'product_id'=ANY(columns) THEN format('%I.product_id::text',p_alias) ELSE 'NULL::text' END;
    parts:=array_append(parts,format('CASE WHEN %1$I.order_id IS NOT NULL THEN jsonb_build_array(%1$I.order_id::text,%2$s)::text END',p_alias,part));
  END IF;
  IF 'ledger_id'=ANY(columns) THEN parts:=array_append(parts,format('%I.ledger_id::text',p_alias)); END IF;
  IF 'period'=ANY(columns) THEN parts:=array_append(parts,format('%I.period::text',p_alias)); END IF;
  IF cardinality(parts)=0 THEN RAISE EXCEPTION 'Unsupported document key: %',p_table; END IF;
  IF cardinality(parts)=1 THEN RETURN parts[1]; END IF;
  RETURN 'COALESCE('||array_to_string(parts,',')||')';
END $$;

-- Keep the reviewed graph and both FK/legacy edges. An owner-only roots argument
-- allows READ ONLY production profiling without inserting real review holds.
DO $graph$
DECLARE original text; anchor text;
BEGIN
  SELECT replace(pg_get_functiondef('public.p118_kept_rows()'::regprocedure),chr(13),'') INTO original;
  original:=replace(original,'FUNCTION public.p118_kept_rows()','FUNCTION public.p119_related_rows(p_roots text[] DEFAULT NULL::text[])');
  original:=replace(original,'DECLARE tables text[];','DECLARE roots text[]; tables text[];');
  anchor:='IF NOT EXISTS(SELECT 1 FROM public.retention_review_orders) THEN RETURN; END IF;';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0119: root contract changed'; END IF;
  original:=replace(original,anchor,'roots:=COALESCE(p_roots,(SELECT array_agg(order_id) FROM public.retention_review_orders));
  IF COALESCE(cardinality(roots),0)=0 THEN RETURN; END IF;');
  anchor:=$anchor$  IF public.p107_is_executing() AND to_regclass('pg_temp._retention_kept') IS NOT NULL THEN
    RETURN QUERY SELECT k.table_name,k.row_id FROM pg_temp._retention_kept k; RETURN;
  END IF;$anchor$;
  anchor:=replace(anchor,chr(13),'');
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0119: graph cache contract changed'; END IF;
  original:=replace(original,anchor,'');
  anchor:='SELECT %L::text,public.p118_row_key(to_jsonb(c)),%L::text,public.p118_row_key(to_jsonb(p)) FROM';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0119: edge key contract changed'; END IF;
  original:=replace(original,anchor,'SELECT %L::text,%s,%L::text,%s FROM');
  original:=replace(original,'ref.child_table,ref.parent_table,ref.child_table,ref.parent_table,joins);',
    'ref.child_table,public.p119_row_key_sql(ref.child_table,''c''),ref.parent_table,public.p119_row_key_sql(ref.parent_table,''p''),ref.child_table,ref.parent_table,joins);');
  original:=replace(original,'pointer.child_table,pointer.parent_table,pointer.child_table,pointer.parent_table,pointer.child_column,pointer.parent_column);',
    'pointer.child_table,public.p119_row_key_sql(pointer.child_table,''c''),pointer.parent_table,public.p119_row_key_sql(pointer.parent_table,''p''),pointer.child_table,pointer.parent_table,pointer.child_column,pointer.parent_column);');
  anchor:=$anchor$SELECT ''orders''::text,order_id FROM public.retention_review_orders$anchor$;
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0119: graph seed changed'; END IF;
  original:=replace(original,anchor,$patch$SELECT ''orders''::text,order_id FROM unnest($1) AS seeds(order_id)$patch$);
  anchor:='SELECT t,i FROM kept'';';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0119: graph execution changed'; END IF;
  original:=replace(original,anchor,'SELECT t,i FROM kept'' USING roots;');
  EXECUTE original;
END $graph$;

CREATE OR REPLACE FUNCTION public.p118_kept_rows() RETURNS TABLE(table_name text,row_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF public.p107_is_executing() AND to_regclass('pg_temp._retention_kept') IS NOT NULL THEN
    RETURN QUERY SELECT k.table_name,k.row_id FROM pg_temp._retention_kept k; RETURN;
  END IF;
  RETURN QUERY SELECT * FROM public.p119_related_rows(NULL);
END $$;

CREATE FUNCTION public.p119_is_kept(p_table text,p_key text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Private helper used only by the already-validated, bound purge RPC.
  IF COALESCE(current_setting('app.retention_job',true),'')='' OR to_regclass('pg_temp._retention_kept') IS NULL THEN RETURN false; END IF;
  RETURN EXISTS(SELECT 1 FROM pg_temp._retention_kept k WHERE k.table_name=p_table AND k.row_id=p_key);
END $$;

DO $cleanup$
DECLARE original text; anchor text; key_sql text; match text[]; old_call text; new_call text;
BEGIN
  SELECT replace(pg_get_functiondef('public.p118_cache_kept()'::regprocedure),chr(13),'') INTO original;
  anchor:=$anchor$EXECUTE format('INSERT INTO pg_temp._retention_kept SELECT $1,public.p118_row_key(to_jsonb(t)),to_jsonb(t)
      FROM public.%I t JOIN pg_temp._retention_kept_seed k ON k.table_name=$1 AND k.row_id=public.p118_row_key(to_jsonb(t))',target) USING target;$anchor$;
  anchor:=replace(anchor,chr(13),'');
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0119: snapshot lookup changed'; END IF;
  original:=replace(original,anchor,'EXECUTE format(''INSERT INTO pg_temp._retention_kept SELECT $1,%s,to_jsonb(t)
      FROM public.%I t JOIN pg_temp._retention_kept_seed k ON k.table_name=$1 AND k.row_id=%s'',
      public.p119_row_key_sql(target,''t''),target,public.p119_row_key_sql(target,''t'')) USING target;');
  EXECUTE original;
  SELECT replace(pg_get_functiondef('public.p118_assert_kept()'::regprocedure),chr(13),'') INTO original;
  anchor:=$anchor$ON k.row_id=public.p118_row_key(to_jsonb(t)) WHERE k.table_name=$1 AND to_jsonb(t) IS DISTINCT FROM k.payload)',target)$anchor$;
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0119: final verification lookup changed'; END IF;
  original:=replace(original,anchor,'ON k.row_id=%s WHERE k.table_name=$1 AND to_jsonb(t) IS DISTINCT FROM k.payload)'',target,public.p119_row_key_sql(target,''t''))');
  EXECUTE original;

  SELECT pg_get_functiondef('public.rpc_execute_monthly_retention(uuid,text,text)'::regprocedure) INTO original;
  FOR match IN SELECT regexp_matches(original,'public\.p118_is_kept\(''([a-z_][a-z0-9_]*)'',to_jsonb\(([a-z_][a-z0-9_]*)\)\)','g') LOOP
    key_sql:=CASE WHEN match[1]='activity_logs_archive_pre_20260804' AND to_regclass('public.activity_logs_archive_pre_20260804') IS NULL
      THEN format('%I.id::text',match[2]) ELSE public.p119_row_key_sql(match[1],match[2]) END;
    old_call:=format('public.p118_is_kept(%L,to_jsonb(%s))',match[1],match[2]);
    new_call:=format('public.p119_is_kept(%L,%s)',match[1],key_sql);
    original:=replace(original,old_call,new_call);
  END LOOP;
  IF original LIKE '%public.p118_is_kept(%' THEN RAISE EXCEPTION '0119: an unreviewed cleanup key remains'; END IF;
  EXECUTE original;

  -- The archive guard continues to allow only an exact reviewed helper body.
  SELECT pg_get_functiondef('public.p107_preview(boolean)'::regprocedure) INTO original;
  anchor:='AND NOT (f.oid=''public.p118_kept_rows()''::regprocedure AND md5(replace(f.prosrc,chr(13),''''))=''c54105b65993e7fd05311e121212b987'')';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0119: archive guard changed'; END IF;
  SELECT 'AND NOT (f.oid=''public.p119_related_rows(text[])''::regprocedure AND md5(replace(f.prosrc,chr(13),''''))='
    ||quote_literal(md5(replace(prosrc,chr(13),'')))||')' INTO new_call
    FROM pg_proc WHERE oid='public.p119_related_rows(text[])'::regprocedure;
  EXECUTE replace(original,anchor,new_call);
END $cleanup$;

REVOKE ALL ON FUNCTION public.p119_row_key_sql(text,text),public.p119_related_rows(text[]),public.p119_is_kept(text,text) FROM PUBLIC,anon,authenticated;
INSERT INTO public.schema_migrations(version,description) VALUES ('0119','Read narrow document keys instead of serializing large audit payloads during reconciliation lookup');
NOTIFY pgrst,'reload schema';
COMMIT;
