BEGIN;

-- PostgREST executes STABLE RPCs in READ ONLY transactions, including POST.
-- Advisory transaction locks serialize with purge without a forbidden row lock.
CREATE OR REPLACE FUNCTION public.p107_assert_epoch() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE current_epoch bigint; headers jsonb; requested text;
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('billing-monthly-retention',0));
  SELECT epoch INTO current_epoch FROM public.retention_control WHERE id;
  IF current_epoch=0 OR auth.uid() IS NULL OR public.p107_is_executing() THEN RETURN; END IF;
  headers:=COALESCE(NULLIF(current_setting('request.headers',true),''),'{}')::jsonb;
  requested:=headers->>'x-retention-epoch';
  IF requested IS DISTINCT FROM current_epoch::text THEN
    RAISE EXCEPTION 'RETENTION_EPOCH_CHANGED: Dữ liệu đã chuyển kỳ. Hãy tải lại ứng dụng trước khi tiếp tục.' USING ERRCODE='40001';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.p107_lock_scope(p_include_archive boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('billing-monthly-retention',0));
  PERFORM 1 FROM public.retention_control WHERE id FOR UPDATE;
  FOREACH target IN ARRAY public.p107_snapshot_tables(p_include_archive) LOOP
    EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE',target);
  END LOOP;
END $$;

DO $migration$
DECLARE original text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_execute_monthly_retention(uuid,text,text)'::regprocedure) INTO original;
  IF original NOT LIKE '%PERFORM 1 FROM public.retention_control WHERE id FOR UPDATE;%'
    OR original LIKE '%pg_advisory_xact_lock(%' THEN RAISE EXCEPTION '0109: unexpected retention lock contract'; END IF;
  EXECUTE replace(original,'PERFORM 1 FROM public.retention_control WHERE id FOR UPDATE;',
    'PERFORM pg_advisory_xact_lock(hashtextextended(''billing-monthly-retention'',0));
  PERFORM 1 FROM public.retention_control WHERE id FOR UPDATE;');
END $migration$;
REVOKE ALL ON FUNCTION public.p107_assert_epoch(),public.p107_lock_scope(boolean) FROM PUBLIC,anon,authenticated;
INSERT INTO public.schema_migrations(version,description)
VALUES ('0109','Coordinate retention through transaction advisory locks compatible with PostgREST READ ONLY RPCs') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
