BEGIN;

-- Match finalized-order history: the Sale who currently manages a customer
-- may read every draft linked to that customer, regardless of who created it
-- or which price list the draft contains. This grants read access only;
-- existing draft insert, update and delete policies remain unchanged.
DROP POLICY IF EXISTS drafts_select ON public.draft_orders;
CREATE POLICY drafts_select ON public.draft_orders
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin_or_accounting()
    OR (
      public.current_profile_role() = 'sale'
      AND customer_id IS NOT NULL
      AND public.can_access_customer(customer_id)
    )
    OR (
      public.can_use_order_price_lists_for_customer(customer_id, pricelist_id, items)
      AND (
        created_by = auth.uid()::text
        OR lower(created_by) = lower(public.current_profile_username())
      )
    )
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'draft_orders'
      AND policy.policyname = 'drafts_select'
      AND policy.cmd = 'SELECT'
      AND policy.roles = ARRAY['authenticated']::name[]
      AND policy.qual LIKE '%current_profile_role()%'
      AND policy.qual LIKE '%can_access_customer(customer_id)%'
      AND policy.qual LIKE '%can_use_order_price_lists_for_customer(customer_id, pricelist_id, items)%'
  ) THEN
    RAISE EXCEPTION 'Migration 0081 stopped: managed-customer draft read policy was not verified';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'draft_orders'
      AND policy.policyname = 'drafts_insert'
      AND policy.cmd = 'INSERT'
      AND policy.with_check LIKE '%can_use_order_price_lists_for_customer%'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'draft_orders'
      AND policy.policyname = 'drafts_update'
      AND policy.cmd = 'UPDATE'
      AND policy.with_check LIKE '%can_use_order_price_lists_for_customer%'
  ) THEN
    RAISE EXCEPTION 'Migration 0081 stopped: draft write restrictions were not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0081', 'Allow Sale to read all drafts of currently managed customers')
ON CONFLICT (version) DO NOTHING;

COMMIT;
