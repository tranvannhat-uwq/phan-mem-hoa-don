BEGIN;

-- Preserve an existing opening-stock cutover and the current on/off behavior.
ALTER TABLE public.inventory_control
  ADD COLUMN sync_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN sync_updated_at timestamptz,
  ADD COLUMN sync_updated_by uuid;
UPDATE public.inventory_control
SET sync_enabled = (activated_at IS NOT NULL), sync_updated_at = now();

CREATE TABLE public.inventory_pending_orders (
  order_id text PRIMARY KEY REFERENCES public.orders(id) ON DELETE RESTRICT,
  queued_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_pending_orders_queue_idx ON public.inventory_pending_orders(queued_at, order_id);
ALTER TABLE public.inventory_pending_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_pending_orders FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.inventory_guard_storage() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE used_bytes bigint;
BEGIN
  SELECT sum(pg_catalog.pg_total_relation_size(t::regclass)) INTO used_bytes
  FROM unnest(ARRAY['public.inventory_control', 'public.inventory_balances',
    'public.inventory_documents', 'public.inventory_movements',
    'public.inventory_order_positions', 'public.inventory_pending_orders']) AS t;
  IF used_bytes >= 63900000 OR pg_catalog.pg_database_size(current_database()) >= 399000000 THEN
    RAISE EXCEPTION 'Kho gần ngưỡng dung lượng an toàn của Free. Cần sao lưu và kiểm tra Usage trước khi ghi thêm.';
  END IF;
END $$;

-- The original, transactional delta algorithm. Only trusted functions below
-- can run it while paused; neither client roles nor service APIs can bypass it.
CREATE FUNCTION private.inventory_apply_order_core(p_order_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE control public.inventory_control; sale public.orders; position record; desired numeric; old_quantity numeric;
BEGIN
  SELECT * INTO control FROM public.inventory_control WHERE id FOR UPDATE;
  IF control.activated_at IS NULL THEN RETURN; END IF;
  SELECT * INTO sale FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN; END IF;
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

CREATE OR REPLACE FUNCTION private.inventory_sync_order(p_order_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE control public.inventory_control; sale public.orders;
BEGIN
  SELECT * INTO control FROM public.inventory_control WHERE id FOR UPDATE;
  IF control.activated_at IS NULL THEN RETURN; END IF;
  SELECT * INTO sale FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF COALESCE(sale.confirmed_at, sale.created_at) < control.activated_at
    AND NOT EXISTS (SELECT 1 FROM public.inventory_order_positions WHERE order_id = p_order_id) THEN RETURN; END IF;
  -- A never-posted draft has no stock delta. Keeping it out of the queue also
  -- preserves the existing ability to delete drafts while synchronization is paused.
  IF sale.status = 'draft'
    AND NOT EXISTS (SELECT 1 FROM public.inventory_order_positions WHERE order_id = p_order_id) THEN RETURN; END IF;
  IF control.sync_enabled THEN
    PERFORM private.inventory_apply_order_core(p_order_id);
    DELETE FROM public.inventory_pending_orders WHERE order_id = p_order_id;
  ELSIF NOT EXISTS (SELECT 1 FROM public.inventory_pending_orders WHERE order_id = p_order_id) THEN
    PERFORM private.inventory_guard_storage();
    INSERT INTO public.inventory_pending_orders(order_id) VALUES (p_order_id) ON CONFLICT DO NOTHING;
  END IF;
END $$;

CREATE FUNCTION private.inventory_guard_pending_count() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  -- A physical count already includes pending sales. Replaying those sales
  -- after that count would deduct them again, so finish reconciliation first.
  IF NEW.kind = 'count' AND EXISTS (SELECT 1 FROM public.inventory_pending_orders) THEN
    RAISE EXCEPTION 'Còn đơn chờ đồng bộ. Hãy xử lý hàng đợi trước khi kiểm kê để tránh trừ tồn hai lần.';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_guard_pending_count BEFORE INSERT ON public.inventory_documents
FOR EACH ROW EXECUTE FUNCTION private.inventory_guard_pending_count();

CREATE FUNCTION public.rpc_inventory_set_sync(
  p_enabled boolean, p_acknowledge_opening boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
<<sync_switch>>
DECLARE
  actor public.profiles; control public.inventory_control; batch_ids text[];
  order_id text; remaining bigint; processed integer := 0; external_enabled boolean;
  next_enabled boolean;
BEGIN
  actor := private.inventory_require_manager();
  IF actor.role <> 'admin' THEN
    RAISE EXCEPTION 'Chỉ Admin được bật hoặc tắt đồng bộ kho.' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN RAISE EXCEPTION 'Cần chọn bật hoặc tắt đồng bộ kho.'; END IF;

  IF p_enabled THEN
    -- Lock order rows BEFORE the control row, like the existing financial
    -- RPCs. Skip an in-flight order instead of deadlocking checkout on resume.
    SELECT COALESCE(array_agg(batch.id), ARRAY[]::text[]) INTO batch_ids FROM (
      SELECT sale.id FROM public.inventory_pending_orders pending
      JOIN public.orders sale ON sale.id = pending.order_id
      ORDER BY pending.queued_at, pending.order_id LIMIT 50
      FOR UPDATE OF sale SKIP LOCKED
    ) batch;
  END IF;
  SELECT * INTO control FROM public.inventory_control WHERE id FOR UPDATE;

  IF p_enabled THEN
    IF to_regclass('private.inventory_sync_settings') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM private.inventory_sync_settings WHERE enabled)' INTO external_enabled;
      IF external_enabled THEN
        RAISE EXCEPTION 'Đồng bộ kho riêng đang bật. Tạm dừng và đối chiếu trước để tránh trừ hai lần.';
      END IF;
    END IF;
    IF control.activated_at IS NULL THEN
      IF p_acknowledge_opening IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'Admin phải xác nhận đã đối chiếu tồn đầu kỳ trước khi bật trừ kho.';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.inventory_documents WHERE kind = 'count') THEN
        RAISE EXCEPTION 'Cần ghi nhận ít nhất một phiếu kiểm kê tồn đầu kỳ.';
      END IF;
      PERFORM private.inventory_guard_storage();
      UPDATE public.inventory_control SET activated_at = clock_timestamp(), activated_by = actor.auth_user_id WHERE id;
    END IF;
    FOREACH order_id IN ARRAY batch_ids LOOP
      PERFORM private.inventory_apply_order_core(order_id);
      DELETE FROM public.inventory_pending_orders pending WHERE pending.order_id = sync_switch.order_id;
      processed := processed + 1;
    END LOOP;
    SELECT count(*) INTO remaining FROM public.inventory_pending_orders;
    next_enabled := (remaining = 0);
    PERFORM private.inventory_charge(8704);
  ELSE
    SELECT count(*) INTO remaining FROM public.inventory_pending_orders;
    next_enabled := false;
    -- Emergency pause remains available when the read budget is exhausted.
    -- Saturate the accounting counter instead of rolling the pause back.
    UPDATE public.inventory_control SET read_budget_used = LEAST(read_budget_limit, read_budget_used + 8704) WHERE id;
  END IF;

  IF control.sync_enabled IS DISTINCT FROM next_enabled THEN
    UPDATE public.inventory_control SET sync_enabled = next_enabled,
      sync_updated_at = clock_timestamp(), sync_updated_by = actor.auth_user_id WHERE id;
    INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by)
    VALUES ('inventory_control', CASE WHEN next_enabled THEN 'SYNC_RESUME' ELSE 'SYNC_PAUSE' END,
      'main', jsonb_build_object('enabled', next_enabled, 'pending_orders', remaining), actor.auth_user_id::text);
  END IF;
  SELECT * INTO control FROM public.inventory_control WHERE id;
  RETURN jsonb_build_object('enabled', control.sync_enabled, 'activatedAt', control.activated_at,
    'pendingOrders', remaining, 'processed', processed, 'updatedAt', control.sync_updated_at);
END $$;

-- Old clients cannot bypass the switch through the original activation RPC.
CREATE OR REPLACE FUNCTION public.rpc_inventory_activate(p_acknowledge_opening boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  RETURN public.rpc_inventory_set_sync(true, p_acknowledge_opening) || jsonb_build_object('activated', true);
END $$;

-- Keep the reviewed window/filter logic from 0088 as a private implementation.
ALTER FUNCTION public.rpc_inventory_window(jsonb) SET SCHEMA private;
ALTER FUNCTION private.rpc_inventory_window(jsonb) RENAME TO inventory_window_v88;
REVOKE ALL ON FUNCTION private.inventory_window_v88(jsonb) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.rpc_inventory_window(p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb; rows_json jsonb; control public.inventory_control; remaining bigint; mode text;
BEGIN
  result := private.inventory_window_v88(p_filters);
  SELECT * INTO control FROM public.inventory_control WHERE id;
  SELECT count(*) INTO remaining FROM public.inventory_pending_orders;
  result := jsonb_set(result, '{control}', (result->'control') || jsonb_build_object(
    'syncAvailable', true, 'syncEnabled', control.sync_enabled, 'pendingOrders', remaining,
    'syncUpdatedAt', control.sync_updated_at));
  result := jsonb_set(result, '{usage,moduleBytes}', to_jsonb((result#>>'{usage,moduleBytes}')::bigint
    + pg_catalog.pg_total_relation_size('public.inventory_pending_orders')));
  mode := COALESCE(p_filters->>'mode', 'stock');
  rows_json := result->'rows';
  WHILE octet_length(result::text) > 32740 LOOP
    IF jsonb_array_length(rows_json) <= 1 THEN RAISE EXCEPTION 'Một dòng kho quá lớn để tải trong ngân sách Free.'; END IF;
    rows_json := rows_json - (jsonb_array_length(rows_json) - 1);
    result := jsonb_set(result, '{rows}', rows_json);
    result := jsonb_set(result, '{hasMore}', 'true'::jsonb);
    result := jsonb_set(result, '{nextCursor}', to_jsonb(rows_json->(jsonb_array_length(rows_json)-1)->>CASE WHEN mode = 'stock' THEN 'product_id' ELSE 'id' END));
  END LOOP;
  -- Extra allowance for the small control metadata; still within the same
  -- 400 MB cycle budget and 32 KiB maximum response as 0088.
  PERFORM private.inventory_charge(1024);
  SELECT * INTO control FROM public.inventory_control WHERE id;
  RETURN jsonb_set(result, '{usage,budgetUsed}', to_jsonb(control.read_budget_used));
END $$;

REVOKE ALL ON FUNCTION private.inventory_apply_order_core(text), private.inventory_guard_pending_count()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_inventory_set_sync(boolean,boolean), public.rpc_inventory_window(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_inventory_set_sync(boolean,boolean), public.rpc_inventory_window(jsonb) TO authenticated;
INSERT INTO public.schema_migrations(version, description)
VALUES ('0089', 'Admin inventory pause/resume with bounded transactional catch-up');
NOTIFY pgrst, 'reload schema';
COMMIT;
