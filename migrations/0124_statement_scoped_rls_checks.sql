BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '15s';

-- Authorization helpers with no row arguments are constant within one SQL
-- statement. InitPlans avoid looking up the same profile for every row.
-- Keep row-dependent helpers, policy roles, commands and restrictive flags.
DO $migration$
DECLARE
  policy_row record;
  using_sql text;
  check_sql text;
  helper_pattern constant text := '\m((public\.)?(is_admin|is_admin_or_accounting|current_profile_role|current_profile_username|get_current_username)\(\))';
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0124') THEN RETURN; END IF;
  FOR policy_row IN SELECT * FROM pg_policies WHERE schemaname = 'public' LOOP
    using_sql := regexp_replace(policy_row.qual, helper_pattern, '(SELECT \1)', 'g');
    check_sql := regexp_replace(policy_row.with_check, helper_pattern, '(SELECT \1)', 'g');
    IF using_sql IS DISTINCT FROM policy_row.qual OR check_sql IS DISTINCT FROM policy_row.with_check THEN
      EXECUTE format('ALTER POLICY %I ON %I.%I%s%s',
        policy_row.policyname, policy_row.schemaname, policy_row.tablename,
        CASE WHEN using_sql IS NULL THEN '' ELSE ' USING (' || using_sql || ')' END,
        CASE WHEN check_sql IS NULL THEN '' ELSE ' WITH CHECK (' || check_sql || ')' END);
    END IF;
  END LOOP;
END
$migration$;

-- Equivalent to the non-admin branches of can_access_customer(text), evaluated
-- once as a set instead of recursively reading a customer/profile per row.
-- SECURITY DEFINER is necessary for the same assignment visibility as the
-- existing helper. Only the authenticated caller's existing customer IDs return.
CREATE OR REPLACE FUNCTION public.rls_my_customer_ids()
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH actor AS MATERIALIZED (
    SELECT auth.uid()::text AS id, lower(public.current_profile_username()) AS username
  )
  SELECT c.id FROM public.customers c CROSS JOIN actor a
  WHERE c.managed_by = a.id
    OR lower(c.managed_by) = a.username
    OR split_part(lower(c.managed_by), '@', 1) = split_part(a.username, '@', 1)
  UNION
  SELECT ca.customer_id FROM public.customer_assignments ca CROSS JOIN actor a
  WHERE ca.is_active = true AND (ca.assigned_to IS NULL OR ca.assigned_to >= now())
    AND (ca.employee_id = a.id
      OR lower(ca.employee_id) = a.username
      OR split_part(lower(ca.employee_id), '@', 1) = split_part(a.username, '@', 1))
$$;
REVOKE ALL ON FUNCTION public.rls_my_customer_ids() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rls_my_customer_ids() TO authenticated;

ALTER POLICY customers_select ON public.customers
  USING ((SELECT public.is_admin_or_accounting()) OR id IN (SELECT public.rls_my_customer_ids()));

INSERT INTO public.schema_migrations(version, description)
VALUES ('0124', 'Evaluate constant RLS profile checks once per statement and customer assignment scope as one set')
ON CONFLICT DO NOTHING;
NOTIFY pgrst, 'reload schema';
COMMIT;
