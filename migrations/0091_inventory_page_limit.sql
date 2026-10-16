BEGIN;

-- Allow a smaller server-side page while preserving the original 50-row default.
-- The public 0089 wrapper still adds sync metadata and the shared read charge.
CREATE OR REPLACE FUNCTION private.inventory_window_v88(p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor public.profiles; control public.inventory_control; mode text; rows_json jsonb; result jsonb;
  query_text text; cursor_text text; start_day date; end_day date; today date;
  cycle date; charge bigint; database_bytes bigint; module_bytes bigint; has_more boolean; page_limit integer;
BEGIN
  actor := private.inventory_require_manager();
  IF octet_length(p_filters::text) > 2048 OR jsonb_typeof(p_filters) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Bộ lọc kho không hợp lệ.'; END IF;
  SELECT * INTO control FROM public.inventory_control WHERE id FOR UPDATE;
  today := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  cycle := (date_trunc('month', today) + interval '20 days')::date;
  IF cycle > today THEN cycle := (cycle - interval '1 month')::date; END IF;
  IF control.cycle_start IS DISTINCT FROM cycle THEN
    UPDATE public.inventory_control SET cycle_start = cycle, read_budget_used = 0 WHERE id;
    control.read_budget_used := 0;
  END IF;
  mode := COALESCE(p_filters->>'mode', 'stock');
  query_text := left(COALESCE(p_filters->>'query', ''), 80);
  cursor_text := NULLIF(p_filters->>'cursor', '');
  page_limit := COALESCE((p_filters->>'limit')::integer, 50);
  IF page_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Mỗi trang kho cần 1–50 dòng.'; END IF;
  IF mode = 'stock' THEN
    WITH candidates AS (
      SELECT p.id AS product_id, left(COALESCE(NULLIF(p.variant_code, ''), p.code), 80) AS sku,
        left(p.name, 100) AS name, left(p.brand, 60) AS brand,
        left(COALESCE(NULLIF(p.packaging_name, ''), p.package_type), 40) AS unit,
        COALESCE(b.quantity, 0) AS quantity, COALESCE(b.minimum_quantity, 0) AS minimum_quantity,
        p.is_active, b.updated_at
      FROM public.products p LEFT JOIN public.inventory_balances b ON b.product_id = p.id
      WHERE NOT p.is_legacy AND (p.is_active OR b.product_id IS NOT NULL)
        AND COALESCE(NULLIF(p.packaging_name, ''), NULLIF(p.package_type, '')) IS NOT NULL
        AND (cursor_text IS NULL OR p.id > cursor_text)
        AND (query_text = '' OR lower(p.code || ' ' || p.name || ' ' || p.brand) LIKE '%' || lower(query_text) || '%')
        AND (COALESCE(p_filters->>'lowOnly', 'false') <> 'true' OR COALESCE(b.quantity, 0) <= COALESCE(b.minimum_quantity, 0))
      ORDER BY p.id LIMIT page_limit + 1
    ) SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY product_id), '[]'::jsonb) INTO rows_json FROM candidates c;
  ELSIF mode = 'movements' THEN
    start_day := COALESCE(NULLIF(p_filters->>'start', '')::date, today - 6);
    end_day := COALESCE(NULLIF(p_filters->>'end', '')::date, today);
    IF end_day < start_day OR end_day - start_day > 30 THEN RAISE EXCEPTION 'Lịch sử kho được xem tối đa 31 ngày mỗi lần.'; END IF;
    WITH candidates AS (
      SELECT m.id, m.product_id, left(COALESCE(NULLIF(p.variant_code, ''), p.code), 80) AS sku,
        left(p.name, 100) AS name, m.delta, m.balance_after, m.kind, m.document_id,
        m.order_id, m.created_at, COALESCE(d.note, '') AS note
      FROM public.inventory_movements m JOIN public.products p ON p.id = m.product_id
      LEFT JOIN public.inventory_documents d ON d.id = m.document_id
      WHERE m.created_at >= (start_day::timestamp AT TIME ZONE 'Asia/Bangkok')
        AND m.created_at < ((end_day + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')
        AND (cursor_text IS NULL OR m.id < cursor_text::bigint)
        AND (query_text = '' OR lower(p.code || ' ' || p.name) LIKE '%' || lower(query_text) || '%')
      ORDER BY m.id DESC LIMIT page_limit + 1
    ) SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id DESC), '[]'::jsonb) INTO rows_json FROM candidates c;
  ELSE RAISE EXCEPTION 'Chế độ xem kho không hợp lệ.';
  END IF;
  has_more := jsonb_array_length(rows_json) > page_limit;
  IF has_more THEN rows_json := rows_json - page_limit; END IF;
  SELECT sum(pg_catalog.pg_total_relation_size(t::regclass)) INTO module_bytes
  FROM unnest(ARRAY['public.inventory_control', 'public.inventory_balances', 'public.inventory_documents',
    'public.inventory_movements', 'public.inventory_order_positions']) AS t;
  database_bytes := pg_catalog.pg_database_size(current_database());
  result := jsonb_build_object('rows', rows_json, 'hasMore', has_more,
    'nextCursor', CASE WHEN has_more THEN rows_json->(page_limit - 1)->>CASE WHEN mode = 'stock' THEN 'product_id' ELSE 'id' END ELSE NULL END,
    'control', jsonb_build_object('activatedAt', control.activated_at, 'warehouseName', control.warehouse_name),
    'usage', jsonb_build_object('cycleStart', cycle, 'budgetUsed', control.read_budget_used,
      'budgetLimit', control.read_budget_limit, 'databaseBytes', database_bytes, 'moduleBytes', module_bytes));
  -- Enforce a byte ceiling as well as a row ceiling, including long UTF-8
  -- names/notes. Preserve the last returned cursor rather than skipping rows.
  WHILE octet_length(result::text) > 32740 LOOP
    IF jsonb_array_length(rows_json) <= 1 THEN RAISE EXCEPTION 'Một dòng kho quá lớn để tải trong ngân sách Free.'; END IF;
    rows_json := rows_json - (jsonb_array_length(rows_json) - 1);
    result := jsonb_set(result, '{rows}', rows_json);
    result := jsonb_set(result, '{hasMore}', 'true'::jsonb);
    result := jsonb_set(result, '{nextCursor}', to_jsonb(rows_json->(jsonb_array_length(rows_json)-1)->>CASE WHEN mode = 'stock' THEN 'product_id' ELSE 'id' END));
  END LOOP;
  -- Conservative accounting: double UTF-8 JSON plus 8 KB for headers/envelope.
  -- This protects this module's estimated output; it is not Supabase telemetry.
  charge := octet_length(result::text) * 2 + 8192;
  PERFORM private.inventory_charge(charge);
  result := jsonb_set(result, '{usage,budgetUsed}', to_jsonb(control.read_budget_used + charge));
  RETURN result;
END $$;


REVOKE ALL ON FUNCTION private.inventory_window_v88(jsonb) FROM PUBLIC, anon, authenticated;
INSERT INTO public.schema_migrations(version, description)
VALUES ('0091', 'Bounded inventory page size for first 15 SKU reads');
COMMIT;
