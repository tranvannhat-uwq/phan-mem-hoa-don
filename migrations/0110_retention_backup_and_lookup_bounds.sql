BEGIN;
-- Bound the real backup before transmitting it and index nested log lookups.
-- These changes only define the workflow; no purge or backup job is executed.
DO $migration$
DECLARE original text; anchor text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_execute_monthly_retention(uuid,text,text)'::regprocedure) INTO original;
  anchor:='CREATE TEMP TABLE _retention_ids(kind text,id text,PRIMARY KEY(kind,id)) ON COMMIT DROP;';
  IF strpos(original,anchor)=0 OR original LIKE '%_retention_ids_lookup_idx%' THEN
    RAISE EXCEPTION '0110: unexpected retention temporary-table contract';
  END IF;
  EXECUTE replace(original,anchor,anchor||chr(10)||'  CREATE INDEX _retention_ids_lookup_idx ON _retention_ids(id);');
  SELECT pg_get_functiondef('public.rpc_prepare_monthly_retention(uuid,boolean)'::regprocedure) INTO original;
  anchor:='backup_text:=payload::text;';
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0110: unexpected backup contract'; END IF;
  EXECUTE replace(original,anchor,anchor||chr(10)||'  IF octet_length(backup_text)>268435456 THEN
    RAISE EXCEPTION ''Bản sao vượt 256 MB. Cần quy trình sao lưu quản trị; chưa tạo lần dọn và chưa xóa dữ liệu.'';
  END IF;');
END $migration$;
ALTER FUNCTION public.rpc_prepare_monthly_retention(uuid,boolean) SET statement_timeout='60s';
ALTER FUNCTION public.rpc_execute_monthly_retention(uuid,text,text) SET statement_timeout='60s';
-- This table was added after the original maintenance-policy sweep.
ALTER POLICY retention_customer_read ON public.retention_customer_balances
  USING (public.can_access_customer(customer_id) AND public.maintenance_access_allowed());
INSERT INTO public.schema_migrations(version,description)
VALUES ('0110','Bound encrypted-recovery source payload and index nested purge-reference lookups') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
