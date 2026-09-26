BEGIN;

-- A finalized order is a historical document. A Sale who can currently read
-- its customer must be able to read that document even if the price list used
-- at the time has since been disabled or replaced on the customer profile.
-- Keep the existing price-list check for orders read through creator or
-- salesperson ownership without current customer access. Draft and mutation
-- policies continue to enforce current price-list authorization.
DROP POLICY IF EXISTS orders_select ON public.orders;
CREATE POLICY orders_select ON public.orders
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
        OR salesperson_id = auth.uid()::text
        OR lower(salesperson_id) = lower(public.current_profile_username())
      )
    )
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'orders'
      AND policy.policyname = 'orders_select'
      AND policy.cmd = 'SELECT'
      AND policy.roles = ARRAY['authenticated']::name[]
      AND policy.qual LIKE '%current_profile_role()%'
      AND policy.qual LIKE '%can_access_customer(customer_id)%'
      AND policy.qual LIKE '%can_use_order_price_lists_for_customer(customer_id, pricelist_id, items)%'
  ) THEN
    RAISE EXCEPTION 'Migration 0080 stopped: historical order read policy was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0080', 'Preserve Sale access to managed customer order history after price-list changes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
