BEGIN;

-- Revalidate the complete authorized snapshot without sending its rows again
-- when the browser already holds identical content. Existing access policies
-- remain intact; the scope matches the existing pricing endpoints.
CREATE OR REPLACE FUNCTION public.rpc_get_pricing_snapshot(
  p_cached_revision text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  snapshot jsonb;
  revision text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting', 'sale') THEN
    RAISE EXCEPTION '403: pricing snapshot requires an authorized pricing role'
      USING ERRCODE = '42501';
  END IF;

  WITH allowed_lists AS MATERIALIZED (
    SELECT price_list.*
    FROM public.pricelists price_list
    WHERE actor.role IN ('admin', 'accounting') OR (
      price_list.is_active = true
      AND price_list.is_available_for_sales = true
      AND price_list.customer_id IS NULL
      AND COALESCE(price_list.price_list_type, price_list.type, 'general')
        NOT IN ('dealer_private', 'customer_specific', 'customer')
    )
  )
  SELECT jsonb_build_object(
    'price_lists', COALESCE((
      SELECT jsonb_agg(to_jsonb(price_list) ORDER BY price_list.id)
      FROM allowed_lists price_list
    ), '[]'::jsonb),
    'items', COALESCE((
      SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id)
      FROM public.price_list_items item
      WHERE actor.role IN ('admin', 'accounting')
        OR EXISTS (SELECT 1 FROM allowed_lists price_list WHERE price_list.id = item.price_list_id)
    ), '[]'::jsonb)
  ) INTO snapshot;

  -- Hash actual content rather than max(updated_at): this detects deletes and
  -- writes that leave timestamps unchanged, as well as list access changes.
  revision := md5(jsonb_build_object(
    'actor_id', actor.auth_user_id,
    'role', actor.role,
    'company_id', actor.company_id,
    'snapshot', snapshot
  )::text);

  IF p_cached_revision = revision THEN
    RETURN jsonb_build_object(
      'actor_id', actor.auth_user_id, 'role', actor.role,
      'revision', revision, 'not_modified', true
    );
  END IF;
  RETURN snapshot || jsonb_build_object(
    'actor_id', actor.auth_user_id, 'role', actor.role,
    'revision', revision, 'not_modified', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_pricing_snapshot(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_pricing_snapshot(text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0082', 'Conditionally return authorized pricing snapshots after exact content validation')
ON CONFLICT(version) DO NOTHING;

COMMIT;
