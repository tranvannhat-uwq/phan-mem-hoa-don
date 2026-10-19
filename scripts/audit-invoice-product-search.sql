-- Read-only comparison after applying 0097. No business rows are changed.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
DO $$ BEGIN
  PERFORM set_config('request.jwt.claim.sub',
    (SELECT auth_user_id::text FROM public.profiles
     WHERE role = 'sale' AND is_active = true ORDER BY auth_user_id LIMIT 1), true);
END $$;
SET LOCAL ROLE authenticated;

WITH responses AS MATERIALIZED (
  SELECT 'old' AS api, public.rpc_egress_search_products('Sơn lót',40,NULL,NULL,true) AS result
  UNION ALL
  SELECT 'new', public.rpc_egress_search_invoice_products('Sơn lót',40,NULL,NULL,'brand_nano10mb')
)
SELECT api, public.current_profile_role() AS profile_role,
  jsonb_array_length(result->'data') AS page_rows,
  result->'hasMore' AS has_more,
  octet_length(result::text) AS response_bytes,
  (SELECT jsonb_object_agg(brand, rows) FROM (
    SELECT value->>'brand' AS brand, count(*) AS rows
    FROM jsonb_array_elements(result->'data') GROUP BY value->>'brand'
  ) counts) AS page_brands
FROM responses ORDER BY api;

ROLLBACK;
