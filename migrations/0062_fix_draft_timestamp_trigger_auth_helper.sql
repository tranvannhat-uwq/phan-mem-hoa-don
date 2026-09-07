BEGIN;

-- Migration 0062: 0059 accidentally called a retired profile helper from the
-- draft timestamp trigger. Any draft update that includes created_at then
-- failed before the row could be saved. Use the established auth-linked helper
-- without changing the existing Admin/Accounting date-edit permission.
CREATE OR REPLACE FUNCTION public.p56_preserve_draft_order_created_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role IN ('admin', 'accounting') THEN
    RETURN NEW;
  END IF;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.p56_preserve_draft_order_created_at()
  FROM PUBLIC, anon, authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0062', 'Fix draft timestamp trigger to use the authenticated profile helper')
ON CONFLICT (version) DO NOTHING;

COMMIT;
