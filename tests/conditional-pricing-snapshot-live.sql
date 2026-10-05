-- Read-only smoke test for migration 0082, run as the SQL Editor's postgres role.
-- JWT claims are transaction-local and are rolled back; no business rows change.
BEGIN;
SET TRANSACTION READ ONLY;

DO $$
DECLARE
  actor public.profiles%ROWTYPE;
  full_snapshot jsonb;
  cached_snapshot jsonb;
  results jsonb := '[]'::jsonb;
  expected_lists bigint;
  expected_items bigint;
  denied boolean := false;
BEGIN
  IF has_function_privilege('anon', 'public.rpc_get_pricing_snapshot(text)', 'EXECUTE')
    OR NOT has_function_privilege('authenticated', 'public.rpc_get_pricing_snapshot(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Pricing RPC grants are incorrect';
  END IF;
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', '{}', true);
  BEGIN
    PERFORM public.rpc_get_pricing_snapshot(NULL);
  EXCEPTION WHEN insufficient_privilege THEN
    denied := true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'Unauthenticated pricing access was not denied'; END IF;

  FOR actor IN
    SELECT DISTINCT ON (role) * FROM public.profiles
    WHERE is_active = true AND role IN ('admin', 'accounting', 'sale')
    ORDER BY role, auth_user_id
  LOOP
    PERFORM set_config('request.jwt.claim.sub', actor.auth_user_id::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', actor.auth_user_id, 'role', 'authenticated')::text, true);
    full_snapshot := public.rpc_get_pricing_snapshot(NULL);
    cached_snapshot := public.rpc_get_pricing_snapshot(full_snapshot->>'revision');
    SELECT count(*) INTO expected_lists FROM public.pricelists p
    WHERE actor.role IN ('admin', 'accounting') OR (
      p.is_active = true AND p.is_available_for_sales = true AND p.customer_id IS NULL
      AND COALESCE(p.price_list_type, p.type, 'general') NOT IN ('dealer_private', 'customer_specific', 'customer')
    );
    SELECT count(*) INTO expected_items FROM public.price_list_items i
    WHERE actor.role IN ('admin', 'accounting') OR EXISTS (
      SELECT 1 FROM public.pricelists p WHERE p.id = i.price_list_id
      AND p.is_active = true AND p.is_available_for_sales = true AND p.customer_id IS NULL
      AND COALESCE(p.price_list_type, p.type, 'general') NOT IN ('dealer_private', 'customer_specific', 'customer')
    );
    IF full_snapshot->>'actor_id' <> actor.auth_user_id::text
      OR full_snapshot->>'role' <> actor.role
      OR full_snapshot->>'not_modified' <> 'false'
      OR jsonb_array_length(full_snapshot->'price_lists') <> expected_lists
      OR jsonb_array_length(full_snapshot->'items') <> expected_items
      OR cached_snapshot->>'not_modified' <> 'true'
      OR cached_snapshot->>'revision' <> full_snapshot->>'revision'
      OR cached_snapshot ? 'items' OR cached_snapshot ? 'price_lists' THEN
      RAISE EXCEPTION 'Snapshot or access validation failed for role %', actor.role;
    END IF;
    results := results || jsonb_build_array(jsonb_build_object(
      'role', actor.role, 'lists', expected_lists, 'items', expected_items,
      'full_json_bytes', octet_length(full_snapshot::text),
      'cached_json_bytes', octet_length(cached_snapshot::text), 'checks', 'PASS'
    ));
  END LOOP;
  IF jsonb_array_length(results) = 0 THEN RAISE EXCEPTION 'No active pricing profiles to verify'; END IF;
  PERFORM set_config('egress_check.results', results::text, true);
END;
$$;

SELECT result->>'role' AS role, result->>'lists' AS lists, result->>'items' AS items,
  result->>'full_json_bytes' AS full_json_bytes,
  result->>'cached_json_bytes' AS cached_json_bytes, result->>'checks' AS checks
FROM jsonb_array_elements(current_setting('egress_check.results')::jsonb) result;
ROLLBACK;
