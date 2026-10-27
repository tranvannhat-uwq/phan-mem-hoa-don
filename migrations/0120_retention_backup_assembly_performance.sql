BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
-- Definitions only. No backup job, review hold or purge is executed here.
DO $migration$
DECLARE original text; anchor text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version='0119') THEN RAISE EXCEPTION '0120 requires 0119'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.rpc_prepare_monthly_retention(uuid,boolean)'::regprocedure
    AND md5(replace(prosrc,chr(13),''))='a941d310473c1e1553dfd2860808d7c8') THEN
    RAISE EXCEPTION '0120: backup function differs from the reviewed version';
  END IF;
  SELECT replace(pg_get_functiondef('public.rpc_prepare_monthly_retention(uuid,boolean)'::regprocedure),chr(13),'') INTO original;
  anchor:='FOREACH target IN ARRAY public.p107_snapshot_tables(p_include_archive) LOOP';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0120: snapshot loop contract changed'; END IF;
  original:=replace(original,anchor,'DROP TABLE IF EXISTS pg_temp._retention_backup_parts;
  CREATE TEMP TABLE _retention_backup_parts(table_name text PRIMARY KEY,table_rows jsonb NOT NULL) ON COMMIT DROP;
  ALTER TABLE pg_temp._retention_backup_parts ALTER COLUMN table_rows SET STORAGE EXTERNAL;
  REVOKE ALL ON pg_temp._retention_backup_parts FROM PUBLIC,anon,authenticated;
  '||anchor);
  anchor:='snapshot:=snapshot||jsonb_build_object(target,rows_data);';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0120: snapshot assembly contract changed'; END IF;
  original:=replace(original,anchor,'INSERT INTO pg_temp._retention_backup_parts(table_name,table_rows) VALUES(target,rows_data);
    rows_data:=NULL;');
  anchor:='FOR sequence_entry IN SELECT sequencename';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0120: sequence metadata contract changed'; END IF;
  original:=replace(original,anchor,'SELECT COALESCE(jsonb_object_agg(table_name,table_rows),''{}''::jsonb) INTO snapshot FROM pg_temp._retention_backup_parts;
  DROP TABLE pg_temp._retention_backup_parts;
  '||anchor);
  anchor:='backup_text:=payload::text;';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0120: backup serialization contract changed'; END IF;
  original:=replace(original,anchor,'snapshot:=NULL;
  backup_text:=payload::text;
  payload:=NULL;');
  EXECUTE original;
END $migration$;
INSERT INTO public.schema_migrations(version,description) VALUES ('0120','Assemble the recovery snapshot once and release large intermediate JSON values');
NOTIFY pgrst,'reload schema';
COMMIT;
