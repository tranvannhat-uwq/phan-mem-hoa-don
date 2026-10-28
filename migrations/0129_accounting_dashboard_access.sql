BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';

-- Existing accountants retain their access until an Admin explicitly changes it.
-- Existing profiles_admin_* RLS policies are the only profile mutation path.
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS can_view_dashboard boolean NOT NULL DEFAULT true;

DO $patch$
DECLARE original text; anchor text:='actor := public.require_authenticated_profile();';
BEGIN
  SELECT pg_get_functiondef('public.rpc_get_phase5_dashboard(jsonb)'::regprocedure) INTO original;
  IF strpos(original,'DASHBOARD_ACCESS_DENIED')=0 THEN
    IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0129: dashboard authentication contract changed'; END IF;
    EXECUTE replace(original,anchor,anchor||E'\n  IF actor.role = ''accounting'' AND NOT actor.can_view_dashboard THEN\n    RAISE EXCEPTION ''DASHBOARD_ACCESS_DENIED: Tài khoản không được xem trang Tổng quan.'' USING ERRCODE=''42501'';\n  END IF;');
  END IF;
  -- Reuse the existing once-per-minute, coordinated session check. This adds
  -- no polling request and reveals only the signed-in user's own permission.
  SELECT pg_get_functiondef('public.rpc_get_maintenance_status()'::regprocedure) INTO original;
  anchor:='''updated_by'', updated_by';
  IF strpos(original,'''can_view_dashboard''')=0 THEN
    IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0129: maintenance status contract changed'; END IF;
    EXECUTE replace(original,anchor,anchor||', ''can_view_dashboard'', (SELECT CASE
      WHEN role=''admin'' THEN true WHEN role=''accounting'' THEN can_view_dashboard ELSE false END
      FROM public.profiles WHERE auth_user_id=auth.uid() AND is_active)');
  END IF;
END $patch$;

DO $audit$
DECLARE original text;
BEGIN
  SELECT pg_get_functiondef('public.p52_is_important_change_field(text)'::regprocedure) INTO original;
  IF strpos(original,'''can_view_dashboard''')=0 THEN
    IF strpos(original,'''status'',')=0 THEN RAISE EXCEPTION '0129: audit field contract changed'; END IF;
    EXECUTE replace(original,'''status'',','''can_view_dashboard'', ''status'',');
  END IF;
END $audit$;

CREATE OR REPLACE FUNCTION public.p129_audit_dashboard_access() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF OLD.can_view_dashboard IS DISTINCT FROM NEW.can_view_dashboard THEN
    INSERT INTO public.audit_logs(table_name,action,record_id,old_data,new_data,performed_by,created_at)
    VALUES('profiles','DASHBOARD_PERMISSION',NEW.id,
      jsonb_build_object('can_view_dashboard',OLD.can_view_dashboard),
      jsonb_build_object('can_view_dashboard',NEW.can_view_dashboard),auth.uid()::text,now());
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.p129_audit_dashboard_access() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS p129_dashboard_access_audit ON public.profiles;
CREATE TRIGGER p129_dashboard_access_audit AFTER UPDATE OF can_view_dashboard ON public.profiles
FOR EACH ROW EXECUTE FUNCTION public.p129_audit_dashboard_access();
INSERT INTO public.schema_migrations(version,description) VALUES('0129','Admin-controlled per-account dashboard visibility; accounting-only RPC restriction, existing sale/admin access unchanged') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
