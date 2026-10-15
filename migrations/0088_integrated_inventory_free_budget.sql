BEGIN;

-- Additive SKU inventory. No legacy inventory tables, HTTP, cron, Realtime or
-- historical order backfill. Activation follows a reconciled opening count.
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE public.inventory_control (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  activated_at timestamptz,
  activated_by uuid,
  warehouse_name text NOT NULL DEFAULT 'Kho chính' CHECK (length(warehouse_name) <= 80),
  cycle_start date,
  read_budget_used bigint NOT NULL DEFAULT 0 CHECK (read_budget_used >= 0),
  read_budget_limit bigint NOT NULL DEFAULT 400000000 CHECK (read_budget_limit BETWEEN 1 AND 400000000)
);
INSERT INTO public.inventory_control(id) VALUES (true);
CREATE TABLE public.inventory_balances (
  product_id text PRIMARY KEY REFERENCES public.products(id) ON DELETE RESTRICT,
  quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  minimum_quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (minimum_quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.inventory_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  request_key uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt', 'issue', 'count')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 240),
  request jsonb NOT NULL CHECK (octet_length(request::text) <= 16000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id, request_key)
);
CREATE TABLE public.inventory_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id text NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  delta numeric(18,4) NOT NULL CHECK (delta <> 0),
  balance_after numeric(18,4) NOT NULL CHECK (balance_after >= 0),
  kind text NOT NULL CHECK (kind IN ('receipt', 'issue', 'count', 'sale')),
  document_id uuid REFERENCES public.inventory_documents(id) ON DELETE RESTRICT,
  order_id text REFERENCES public.orders(id) ON DELETE RESTRICT,
  actor_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_movements_date_idx ON public.inventory_movements(created_at DESC, id DESC);
CREATE INDEX inventory_movements_product_idx ON public.inventory_movements(product_id, id DESC);
CREATE TABLE public.inventory_order_positions (
  order_id text NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  product_id text NOT NULL REFERENCES public.products(id) ON DELETE RESTRICT,
  quantity numeric(18,4) NOT NULL CHECK (quantity >= 0),
  PRIMARY KEY(order_id, product_id)
);

-- Only bounded RPCs can read/write inventory; a direct table request cannot
-- bypass the query budget, permissions, idempotency or balance invariant.
ALTER TABLE public.inventory_control ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_order_positions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_control, public.inventory_balances,
  public.inventory_documents, public.inventory_movements, public.inventory_order_positions
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.inventory_movements_id_seq FROM PUBLIC, anon, authenticated;

CREATE FUNCTION private.inventory_require_manager() RETURNS public.profiles
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.profiles;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION 'Chỉ Admin và Kế toán được quản lý kho.' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END $$;

CREATE FUNCTION private.inventory_guard_storage() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE used_bytes bigint;
BEGIN
  SELECT sum(pg_catalog.pg_total_relation_size(t::regclass)) INTO used_bytes
  FROM unnest(ARRAY['public.inventory_control', 'public.inventory_balances',
    'public.inventory_documents', 'public.inventory_movements',
    'public.inventory_order_positions']) AS t;
  IF used_bytes >= 63900000 OR pg_catalog.pg_database_size(current_database()) >= 399000000 THEN
    RAISE EXCEPTION 'Kho gần ngưỡng dung lượng an toàn của Free. Cần sao lưu và kiểm tra Usage trước khi ghi thêm.';
  END IF;
END $$;

CREATE FUNCTION private.inventory_charge(p_charge bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE control public.inventory_control; today date; cycle date;
BEGIN
  SELECT * INTO control FROM public.inventory_control WHERE id FOR UPDATE;
  today := (now() AT TIME ZONE 'Asia/Bangkok')::date;
  cycle := (date_trunc('month', today) + interval '20 days')::date;
  IF cycle > today THEN cycle := (cycle - interval '1 month')::date; END IF;
  IF control.cycle_start IS DISTINCT FROM cycle THEN
    UPDATE public.inventory_control SET cycle_start = cycle, read_budget_used = 0 WHERE id;
    control.read_budget_used := 0;
  END IF;
  IF control.read_budget_used + p_charge > control.read_budget_limit THEN
    RAISE EXCEPTION 'Đã hết ngân sách đọc kho trong chu kỳ Free. Kiểm tra Supabase Usage trước khi tiếp tục.';
  END IF;
  UPDATE public.inventory_control SET read_budget_used = read_budget_used + p_charge WHERE id;
END $$;

CREATE FUNCTION private.inventory_apply_delta(
  p_product text, p_delta numeric, p_kind text, p_document uuid, p_order text, p_actor uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE next_quantity numeric; rounded_delta numeric;
BEGIN
  rounded_delta := round(p_delta, 4);
  IF rounded_delta = 0 THEN RETURN; END IF;
  PERFORM private.inventory_guard_storage();
  INSERT INTO public.inventory_balances(product_id) VALUES (p_product) ON CONFLICT DO NOTHING;
  SELECT quantity + rounded_delta INTO next_quantity FROM public.inventory_balances
  WHERE product_id = p_product FOR UPDATE;
  IF next_quantity < 0 THEN
    RAISE EXCEPTION 'SKU % không đủ tồn kho (thiếu %).', p_product, -next_quantity;
  END IF;
  UPDATE public.inventory_balances SET quantity = next_quantity, updated_at = now()
  WHERE product_id = p_product;
  INSERT INTO public.inventory_movements(product_id, delta, balance_after, kind, document_id, order_id, actor_id)
  VALUES (p_product, rounded_delta, next_quantity, p_kind, p_document, p_order, p_actor);
END $$;

CREATE FUNCTION public.rpc_inventory_post(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
<<inventory_post>>
DECLARE
  actor public.profiles; prior public.inventory_documents; doc_id uuid;
  request_key uuid; kind text; item jsonb; product_id text; quantity numeric;
  current_quantity numeric; minimum_quantity numeric; delta numeric;
BEGIN
  actor := private.inventory_require_manager();
  PERFORM 1 FROM public.inventory_control WHERE id FOR UPDATE;
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text) > 16000
    OR jsonb_typeof(p_input->'items') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Phiếu kho không hợp lệ.';
  END IF;
  kind := p_input->>'kind'; request_key := (p_input->>'requestKey')::uuid;
  IF kind IS NULL OR kind NOT IN ('receipt', 'issue', 'count') OR request_key IS NULL
    OR jsonb_array_length(p_input->'items') NOT BETWEEN 1 AND 50
    OR length(COALESCE(p_input->>'note', '')) > 240 THEN
    RAISE EXCEPTION 'Phiếu kho cần 1–50 SKU, mã yêu cầu và ghi chú tối đa 240 ký tự.';
  END IF;
  SELECT * INTO prior FROM public.inventory_documents
  WHERE actor_id = actor.auth_user_id AND inventory_documents.request_key = inventory_post.request_key;
  IF FOUND THEN
    IF prior.request IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng cho một phiếu khác.'; END IF;
    PERFORM private.inventory_charge(8704);
    RETURN jsonb_build_object('id', prior.id, 'replayed', true);
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(p_input->'items')) <>
     (SELECT count(DISTINCT value->>'productId') FROM jsonb_array_elements(p_input->'items')) THEN
    RAISE EXCEPTION 'SKU trong phiếu phải khác nhau.';
  END IF;
  PERFORM private.inventory_guard_storage();
  INSERT INTO public.inventory_documents(actor_id, request_key, kind, note, request)
  VALUES (actor.auth_user_id, request_key, kind, COALESCE(p_input->>'note', ''), p_input) RETURNING id INTO doc_id;
  FOR item IN SELECT value FROM jsonb_array_elements(p_input->'items') ORDER BY value->>'productId' LOOP
    product_id := item->>'productId'; quantity := (item->>'quantity')::numeric;
    IF quantity IS NULL OR quantity < 0 OR quantity > 100000000 OR quantity <> round(quantity, 4)
      OR (kind <> 'count' AND quantity = 0) THEN RAISE EXCEPTION 'Số lượng không hợp lệ.'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = product_id
      AND NOT p.is_legacy AND (kind = 'count' OR p.is_active)
      AND COALESCE(NULLIF(p.packaging_name, ''), NULLIF(p.package_type, '')) IS NOT NULL) THEN
      RAISE EXCEPTION 'SKU % không tồn tại hoặc không còn sử dụng.', product_id;
    END IF;
    INSERT INTO public.inventory_balances(product_id) VALUES (product_id) ON CONFLICT DO NOTHING;
    SELECT b.quantity INTO current_quantity FROM public.inventory_balances b WHERE b.product_id = inventory_post.product_id FOR UPDATE;
    IF kind = 'count' THEN
      IF (item->>'expectedQuantity') IS NULL OR (item->>'expectedQuantity')::numeric <> current_quantity THEN
        RAISE EXCEPTION 'Tồn kho đã thay đổi. Tải lại số tồn trước khi lưu kiểm kê.';
      END IF;
      minimum_quantity := COALESCE((item->>'minimumQuantity')::numeric, 0);
      IF minimum_quantity < 0 OR minimum_quantity > 100000000 OR minimum_quantity <> round(minimum_quantity, 4) THEN
        RAISE EXCEPTION 'Mức tồn tối thiểu không hợp lệ.';
      END IF;
      UPDATE public.inventory_balances b SET minimum_quantity = inventory_post.minimum_quantity,
        updated_at = now() WHERE b.product_id = inventory_post.product_id;
      delta := quantity - current_quantity;
    ELSE delta := CASE WHEN kind = 'issue' THEN -quantity ELSE quantity END;
    END IF;
    PERFORM private.inventory_apply_delta(product_id, delta, kind, doc_id, NULL, actor.auth_user_id);
  END LOOP;
  PERFORM private.inventory_charge(8704);
  RETURN jsonb_build_object('id', doc_id, 'replayed', false);
END $$;

CREATE FUNCTION public.rpc_inventory_activate(p_acknowledge_opening boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.profiles; control public.inventory_control;
BEGIN
  actor := private.inventory_require_manager();
  IF actor.role <> 'admin' OR p_acknowledge_opening IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Admin phải xác nhận đã đối chiếu tồn đầu kỳ trước khi bật trừ kho.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO control FROM public.inventory_control WHERE id FOR UPDATE;
  IF control.activated_at IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.inventory_documents WHERE kind = 'count') THEN
      RAISE EXCEPTION 'Cần ghi nhận ít nhất một phiếu kiểm kê tồn đầu kỳ.';
    END IF;
    IF to_regclass('private.inventory_sync_settings') IS NOT NULL THEN
      DECLARE external_enabled boolean;
      BEGIN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM private.inventory_sync_settings WHERE enabled)' INTO external_enabled;
        IF external_enabled THEN
          RAISE EXCEPTION 'Đồng bộ kho riêng đang bật. Tạm dừng và đối chiếu trước để tránh trừ hai lần.';
        END IF;
      END;
    END IF;
    PERFORM private.inventory_guard_storage();
    UPDATE public.inventory_control SET activated_at = clock_timestamp(), activated_by = actor.auth_user_id WHERE id;
  END IF;
  PERFORM private.inventory_charge(8704);
  RETURN jsonb_build_object('activated', true);
END $$;

CREATE FUNCTION private.inventory_sync_order(p_order_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE control public.inventory_control; sale public.orders; position record; desired numeric; old_quantity numeric;
BEGIN
  SELECT * INTO control FROM public.inventory_control WHERE id FOR UPDATE;
  IF control.activated_at IS NULL THEN RETURN; END IF;
  SELECT * INTO sale FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN; END IF;
  -- Only orders confirmed after the opening-stock cutover. A late transaction
  -- with an earlier transaction timestamp also remains outside the new ledger.
  IF COALESCE(sale.confirmed_at, sale.created_at) < control.activated_at
    AND NOT EXISTS (SELECT 1 FROM public.inventory_order_positions WHERE order_id = p_order_id) THEN RETURN; END IF;
  FOR position IN
    SELECT DISTINCT sku FROM (
      SELECT COALESCE(NULLIF(i.variant_id, ''), i.product_id) AS sku FROM public.order_items i WHERE i.order_id = p_order_id
      UNION SELECT product_id FROM public.inventory_order_positions WHERE order_id = p_order_id
    ) all_skus ORDER BY sku
  LOOP
    IF position.sku IS NULL THEN RAISE EXCEPTION 'Đơn % thiếu SKU để ghi nhận kho.', p_order_id; END IF;
    SELECT COALESCE(sum(i.quantity - COALESCE(i.returned_quantity, 0)), 0) INTO desired
    FROM public.order_items i WHERE i.order_id = p_order_id
      AND COALESCE(NULLIF(i.variant_id, ''), i.product_id) = position.sku;
    IF sale.status IN ('cancelled', 'canceled', 'draft') THEN desired := 0; END IF;
    IF desired < 0 THEN RAISE EXCEPTION 'Số lượng trả vượt số lượng bán.'; END IF;
    IF desired <> round(desired, 4) THEN RAISE EXCEPTION 'Số lượng SKU % vượt 4 chữ số thập phân cho kho.', position.sku; END IF;
    SELECT quantity INTO old_quantity FROM public.inventory_order_positions WHERE order_id = p_order_id AND product_id = position.sku;
    old_quantity := COALESCE(old_quantity, 0);
    IF desired <> old_quantity THEN
      PERFORM private.inventory_apply_delta(position.sku, old_quantity - desired, 'sale', NULL, p_order_id, auth.uid());
      INSERT INTO public.inventory_order_positions(order_id, product_id, quantity) VALUES (p_order_id, position.sku, desired)
      ON CONFLICT(order_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity;
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION private.inventory_order_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'orders' THEN
    PERFORM private.inventory_sync_order(NEW.id);
  ELSE
    PERFORM private.inventory_sync_order(NEW.order_id);
  END IF;
  RETURN NULL;
END $$;
-- Read canonical rows at transaction end, after confirm/amend/return finishes.
-- Repeated trigger invocations compare current positions and do not double-post.
CREATE CONSTRAINT TRIGGER inventory_order_commit AFTER INSERT OR UPDATE ON public.orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.inventory_order_trigger();
CREATE CONSTRAINT TRIGGER inventory_item_commit AFTER UPDATE ON public.order_items
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN (OLD.returned_quantity IS DISTINCT FROM NEW.returned_quantity)
  EXECUTE FUNCTION private.inventory_order_trigger();

CREATE FUNCTION public.rpc_inventory_window(p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  actor public.profiles; control public.inventory_control; mode text; rows_json jsonb; result jsonb;
  query_text text; cursor_text text; start_day date; end_day date; today date;
  cycle date; charge bigint; database_bytes bigint; module_bytes bigint; has_more boolean;
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
      ORDER BY p.id LIMIT 51
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
      ORDER BY m.id DESC LIMIT 51
    ) SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id DESC), '[]'::jsonb) INTO rows_json FROM candidates c;
  ELSE RAISE EXCEPTION 'Chế độ xem kho không hợp lệ.';
  END IF;
  has_more := jsonb_array_length(rows_json) > 50;
  IF has_more THEN rows_json := rows_json - 50; END IF;
  SELECT sum(pg_catalog.pg_total_relation_size(t::regclass)) INTO module_bytes
  FROM unnest(ARRAY['public.inventory_control', 'public.inventory_balances', 'public.inventory_documents',
    'public.inventory_movements', 'public.inventory_order_positions']) AS t;
  database_bytes := pg_catalog.pg_database_size(current_database());
  result := jsonb_build_object('rows', rows_json, 'hasMore', has_more,
    'nextCursor', CASE WHEN has_more THEN rows_json->49->>CASE WHEN mode = 'stock' THEN 'product_id' ELSE 'id' END ELSE NULL END,
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

REVOKE ALL ON FUNCTION private.inventory_require_manager(), private.inventory_guard_storage(),
  private.inventory_charge(bigint),
  private.inventory_apply_delta(text,numeric,text,uuid,text,uuid), private.inventory_sync_order(text),
  private.inventory_order_trigger() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_inventory_post(jsonb), public.rpc_inventory_activate(boolean),
  public.rpc_inventory_window(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_inventory_post(jsonb), public.rpc_inventory_activate(boolean),
  public.rpc_inventory_window(jsonb) TO authenticated;
INSERT INTO public.schema_migrations(version, description)
VALUES ('0088', 'Integrated atomic SKU inventory with bounded reads and conservative Free budget');
COMMIT;
