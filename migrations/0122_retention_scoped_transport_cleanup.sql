BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
-- Definition change only. No business deletion or backup job is executed.
DO $patch$
DECLARE original text; anchor text:='DELETE FROM public.retention_backup_sessions;';
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version='0121') THEN RAISE EXCEPTION '0122 requires 0121'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.rpc_execute_monthly_retention(uuid,text,text)'::regprocedure
    AND md5(replace(prosrc,chr(13),''))='d367de815798b2270a9e67fe62306e1d') THEN
    RAISE EXCEPTION '0122: purge function differs from the reviewed version';
  END IF;
  SELECT replace(pg_get_functiondef('public.rpc_execute_monthly_retention(uuid,text,text)'::regprocedure),chr(13),'') INTO original;
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0122: transport cleanup contract changed'; END IF;
  EXECUTE replace(original,anchor,'DELETE FROM public.retention_backup_sessions WHERE epoch<=job.epoch_before;');
END $patch$;
INSERT INTO public.schema_migrations(version,description) VALUES ('0122','Scope transport cleanup to retired epochs for the production safe-delete guard');
NOTIFY pgrst,'reload schema';
COMMIT;
