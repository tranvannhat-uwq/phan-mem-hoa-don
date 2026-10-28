BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='45s';
DO $guard$
DECLARE before_dashboard_audit text;
BEGIN
 -- 0129 added only the profile permission audit trigger after the last stored
 -- retention fingerprint. Accept that known additive difference explicitly;
 -- any drift in other triggers still blocks this migration.
 SELECT encode(sha256(convert_to(COALESCE(string_agg(pg_get_triggerdef(t.oid)||':'||pg_get_functiondef(t.tgfoid),
   E'\n' ORDER BY c.relname,t.tgname),''),'UTF8')),'hex') INTO before_dashboard_audit
 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname=ANY(public.p107_snapshot_tables(true))
   AND NOT(c.relname='profiles' AND t.tgname='p129_dashboard_access_audit');
 IF EXISTS(SELECT 1 FROM public.retention_control WHERE id AND expected_trigger_hash IS DISTINCT FROM public.p107_trigger_fingerprint()
   AND expected_trigger_hash IS DISTINCT FROM before_dashboard_audit) THEN
   RAISE EXCEPTION '0130: existing retention trigger contract has drifted; review before migrating.';
 END IF;
END $guard$;
-- Preserve existing global cutovers. New warehouses can enable one SKU at a time.
ALTER TABLE public.inventory_control ADD COLUMN sync_mode text NOT NULL DEFAULT 'all' CHECK(sync_mode IN ('all','selected'));
CREATE TABLE public.inventory_product_sync (
  product_id text PRIMARY KEY REFERENCES public.products(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 0,
  enabled_at timestamptz,
  enabled_by uuid,
  -- Retention can retire a voucher while preserving the SKU cutover.
  count_document_id uuid REFERENCES public.inventory_documents(id) ON DELETE SET NULL
);
ALTER TABLE public.inventory_product_sync ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.inventory_product_sync FROM PUBLIC,anon,authenticated;
CREATE INDEX inventory_order_items_sku_idx ON public.order_items ((COALESCE(NULLIF(variant_id,''),product_id)),order_id);

CREATE FUNCTION private.inventory_product_context(p_product_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('productId',p_product_id,'quantity',COALESCE(b.quantity,0),
   'minimumQuantity',COALESCE(b.minimum_quantity,0),
   'syncActive',c.activated_at IS NOT NULL AND (c.sync_mode='all' OR s.enabled_at IS NOT NULL),
   'syncEnabled',c.sync_enabled,'syncMode',c.sync_mode,
   'token',md5(jsonb_build_array(s.revision,COALESCE(b.quantity,0),b.updated_at,s.enabled_at,
     c.activated_at IS NOT NULL AND (c.sync_mode='all' OR s.enabled_at IS NOT NULL),
     CASE WHEN c.activated_at IS NOT NULL AND (c.sync_mode='all' OR s.enabled_at IS NOT NULL) THEN c.sync_enabled END)::text))
 FROM public.inventory_control c LEFT JOIN public.inventory_product_sync s ON s.product_id=p_product_id
 LEFT JOIN public.inventory_balances b ON b.product_id=p_product_id WHERE c.id
$$;
CREATE FUNCTION public.rpc_inventory_count_context(p_product_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM private.inventory_require_manager();
 PERFORM 1 FROM public.inventory_control WHERE id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM public.products WHERE id=p_product_id AND NOT is_legacy
   AND COALESCE(NULLIF(packaging_name,''),NULLIF(package_type,'')) IS NOT NULL) THEN RAISE EXCEPTION 'SKU không hợp lệ.'; END IF;
 PERFORM private.inventory_guard_storage();
 INSERT INTO public.inventory_product_sync(product_id) VALUES(p_product_id) ON CONFLICT DO NOTHING;
 PERFORM private.inventory_charge(2048);
 RETURN private.inventory_product_context(p_product_id);
END $$;

CREATE FUNCTION public.rpc_inventory_count_product(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles; control public.inventory_control; prior public.inventory_documents;
 context jsonb; product text; result jsonb; enable_product boolean; external_enabled boolean; baseline_orders text[];
BEGIN
 actor:=private.inventory_require_manager();
 IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR octet_length(p_input::text)>16000
   OR p_input->>'kind' IS DISTINCT FROM 'count' OR jsonb_typeof(p_input->'items') IS DISTINCT FROM 'array'
   OR jsonb_array_length(p_input->'items')<>1 OR jsonb_typeof(p_input->'activateProduct') IS DISTINCT FROM 'boolean' THEN
   RAISE EXCEPTION 'Mỗi lần kiểm kê và đồng bộ cần đúng một SKU.'; END IF;
 product:=p_input#>>'{items,0,productId}';
 -- FK inserts require order KEY SHARE locks. Acquire these BEFORE control,
 -- matching checkout's lock order; fail promptly if this SKU is in flight.
 IF (p_input->>'activateProduct')::boolean AND NOT (private.inventory_product_context(product)->>'syncActive')::boolean THEN
   BEGIN
     SELECT COALESCE(array_agg(batch.id),ARRAY[]::text[]) INTO baseline_orders FROM (
       SELECT o.id FROM public.orders o WHERE o.status NOT IN ('draft','cancelled','canceled') AND EXISTS(
         SELECT 1 FROM public.order_items i WHERE i.order_id=o.id AND COALESCE(NULLIF(i.variant_id,''),i.product_id)=product)
       ORDER BY o.id LIMIT 20001 FOR KEY SHARE OF o NOWAIT
     ) batch;
   EXCEPTION WHEN lock_not_available THEN
     RAISE EXCEPTION 'SKU đang có đơn được xử lý. Mở lại kiểm kê và kiểm tra số đếm.' USING ERRCODE='PT409';
   END;
   IF cardinality(baseline_orders)>20000 THEN RAISE EXCEPTION 'SKU có quá nhiều đơn lịch sử để khởi tạo trong một lượt.'; END IF;
 END IF;
 SELECT * INTO control FROM public.inventory_control WHERE id FOR UPDATE;
 SELECT * INTO prior FROM public.inventory_documents WHERE actor_id=actor.auth_user_id AND request_key=(p_input->>'requestKey')::uuid;
 IF FOUND THEN
   IF prior.request IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng cho một phiếu khác.'; END IF;
   PERFORM private.inventory_charge(2048);
   RETURN jsonb_build_object('id',prior.id,'replayed',true);
 END IF;
 context:=private.inventory_product_context(product);
 IF NOT EXISTS(SELECT 1 FROM public.inventory_product_sync WHERE product_id=product)
   OR p_input->>'countToken' IS DISTINCT FROM context->>'token' THEN
   RAISE EXCEPTION 'SKU đã có biến động từ lúc mở kiểm kê. Đóng phiếu, mở lại và kiểm tra số đếm của riêng SKU này.' USING ERRCODE='PT409'; END IF;
 enable_product:=(p_input->>'activateProduct')::boolean AND NOT (context->>'syncActive')::boolean;
 IF enable_product AND control.activated_at IS NOT NULL AND NOT control.sync_enabled THEN
   RAISE EXCEPTION 'Đồng bộ kho đang tạm dừng. Admin cần xử lý hàng đợi và bật lại trước khi đồng bộ thêm SKU.'; END IF;
 IF enable_product AND to_regclass('private.inventory_sync_settings') IS NOT NULL THEN
   EXECUTE 'SELECT EXISTS(SELECT 1 FROM private.inventory_sync_settings WHERE enabled)' INTO external_enabled;
   IF external_enabled THEN RAISE EXCEPTION 'Đồng bộ kho riêng đang bật. Cần tạm dừng trước để tránh trừ hai lần.'; END IF;
 END IF;
 result:=public.rpc_inventory_post(p_input);
 IF enable_product THEN
   IF control.activated_at IS NULL THEN
     UPDATE public.inventory_control SET sync_mode='selected',activated_at=clock_timestamp(),activated_by=actor.auth_user_id,
       sync_enabled=true,sync_updated_at=clock_timestamp(),sync_updated_by=actor.auth_user_id WHERE id;
   END IF;
   -- Record historical quantities as a baseline, never as stock movements.
   -- Returns/amendments/cancellations after the count apply only their delta.
   -- In-flight checkouts wait on control and apply after this baseline.
   IF (SELECT count(*) FROM public.order_items i WHERE COALESCE(NULLIF(i.variant_id,''),i.product_id)=product)>20000 THEN
     RAISE EXCEPTION 'SKU có quá nhiều dòng lịch sử để khởi tạo trong một lượt. Cần quản trị kiểm tra trước.'; END IF;
   INSERT INTO public.inventory_order_positions(order_id,product_id,quantity)
   SELECT i.order_id,product,sum(i.quantity-COALESCE(i.returned_quantity,0))
   FROM public.order_items i JOIN public.orders o ON o.id=i.order_id
   WHERE COALESCE(NULLIF(i.variant_id,''),i.product_id)=product AND o.id=ANY(baseline_orders) AND o.status NOT IN ('draft','cancelled','canceled')
   GROUP BY i.order_id HAVING sum(i.quantity-COALESCE(i.returned_quantity,0))>0
   ON CONFLICT(order_id,product_id) DO UPDATE SET quantity=EXCLUDED.quantity;
   UPDATE public.inventory_product_sync SET enabled_at=clock_timestamp(),enabled_by=actor.auth_user_id,
     count_document_id=(result->>'id')::uuid WHERE product_id=product;
   PERFORM private.inventory_guard_storage();
   INSERT INTO public.audit_logs(table_name,action,record_id,new_data,performed_by)
   VALUES('inventory_product_sync','COUNT_AND_ENABLE',product,p_input,actor.auth_user_id::text);
 END IF;
 RETURN result||jsonb_build_object('productId',product,'syncActive',enable_product OR (context->>'syncActive')::boolean);
END $$;

CREATE OR REPLACE FUNCTION private.inventory_apply_order_core(p_order_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE control public.inventory_control; sale public.orders; position record; desired numeric; old_quantity numeric;
BEGIN
  SELECT * INTO control FROM public.inventory_control WHERE id FOR UPDATE;
  IF control.activated_at IS NULL THEN RETURN; END IF;
  SELECT * INTO sale FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF control.sync_mode = 'all' AND COALESCE(sale.confirmed_at, sale.created_at) < control.activated_at
    AND NOT EXISTS (SELECT 1 FROM public.inventory_order_positions WHERE order_id = p_order_id) THEN RETURN; END IF;
  FOR position IN
    SELECT DISTINCT sku FROM (
      SELECT COALESCE(NULLIF(i.variant_id, ''), i.product_id) AS sku FROM public.order_items i WHERE i.order_id = p_order_id
      UNION SELECT product_id FROM public.inventory_order_positions WHERE order_id = p_order_id
    ) all_skus ORDER BY sku
  LOOP
    IF control.sync_mode = 'selected' AND NOT EXISTS (SELECT 1 FROM public.inventory_product_sync s WHERE s.product_id=position.sku AND s.enabled_at IS NOT NULL) THEN CONTINUE; END IF;
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
  -- Watch only SKUs whose count was opened, also before first activation.
  UPDATE public.inventory_product_sync s SET revision=s.revision+1 WHERE s.product_id IN (
    SELECT COALESCE(NULLIF(i.variant_id,''),i.product_id) FROM public.order_items i WHERE i.order_id=p_order_id
    UNION SELECT product_id FROM public.inventory_order_positions WHERE order_id=p_order_id);
  IF control.activated_at IS NULL THEN RETURN; END IF;
  SELECT * INTO sale FROM public.orders WHERE id = p_order_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF control.sync_mode = 'all' AND COALESCE(sale.confirmed_at, sale.created_at) < control.activated_at
    AND NOT EXISTS (SELECT 1 FROM public.inventory_order_positions WHERE order_id = p_order_id) THEN RETURN; END IF;
  -- A never-posted draft has no stock delta. Keeping it out of the queue also
  -- preserves the existing ability to delete drafts while synchronization is paused.
  IF sale.status = 'draft'
    AND NOT EXISTS (SELECT 1 FROM public.inventory_order_positions WHERE order_id = p_order_id) THEN RETURN; END IF;
  IF control.sync_mode='selected' AND NOT EXISTS (
    SELECT 1 FROM public.inventory_product_sync s WHERE s.enabled_at IS NOT NULL AND s.product_id IN (
      SELECT COALESCE(NULLIF(i.variant_id,''),i.product_id) FROM public.order_items i WHERE i.order_id=p_order_id
      UNION SELECT product_id FROM public.inventory_order_positions WHERE order_id=p_order_id)
  ) THEN RETURN; END IF;
  IF control.sync_enabled THEN
    PERFORM private.inventory_apply_order_core(p_order_id);
    DELETE FROM public.inventory_pending_orders WHERE order_id = p_order_id;
  ELSIF NOT EXISTS (SELECT 1 FROM public.inventory_pending_orders WHERE order_id = p_order_id) THEN
    PERFORM private.inventory_guard_storage();
    INSERT INTO public.inventory_pending_orders(order_id) VALUES (p_order_id) ON CONFLICT DO NOTHING;
  END IF;
END $$;



-- Detect also an item removed/replaced during counting, before its SKU has
-- positions. Use deferred canonical state, like the existing order trigger.
CREATE FUNCTION private.inventory_product_item_trigger() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE old_sku text; new_sku text;
BEGIN
 IF public.p107_is_executing() THEN RETURN NULL; END IF;
 IF TG_OP<>'INSERT' THEN old_sku:=COALESCE(NULLIF(OLD.variant_id,''),OLD.product_id); END IF;
 IF TG_OP<>'DELETE' THEN new_sku:=COALESCE(NULLIF(NEW.variant_id,''),NEW.product_id); END IF;
 IF EXISTS(SELECT 1 FROM public.inventory_product_sync WHERE product_id IN(old_sku,new_sku)) THEN
   PERFORM 1 FROM public.inventory_control WHERE id FOR UPDATE;
   UPDATE public.inventory_product_sync SET revision=revision+1 WHERE product_id IN(old_sku,new_sku);
 END IF;
 -- Confirm/amend already schedules the order trigger once. Do not rescan an
 -- entire multi-line order for every inserted item. Returns retain their
 -- existing item-trigger path, including zero-value returns.
 IF TG_OP='UPDATE' THEN
   IF OLD.returned_quantity IS DISTINCT FROM NEW.returned_quantity THEN
     PERFORM private.inventory_sync_order(NEW.order_id);
   END IF;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER inventory_item_commit ON public.order_items;
CREATE CONSTRAINT TRIGGER inventory_item_commit AFTER INSERT OR UPDATE OR DELETE ON public.order_items
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.inventory_product_item_trigger();
REVOKE ALL ON FUNCTION private.inventory_product_item_trigger() FROM PUBLIC,anon,authenticated;

-- Include new metadata in the same storage guard used by every stock write.
DO $patch$
DECLARE original text;
BEGIN
 original:=pg_get_functiondef('private.inventory_guard_storage()'::regprocedure);
 IF strpos(original,'''public.inventory_control''')=0 THEN RAISE EXCEPTION 'Unexpected storage guard'; END IF;
 EXECUTE replace(original,'''public.inventory_control''','''public.inventory_product_sync'', ''public.inventory_control''');
END $patch$;

DO $patch$
DECLARE original text;
BEGIN
 original:=pg_get_functiondef('public.p107_snapshot_tables(boolean)'::regprocedure);
 IF strpos(original,'''inventory_control''')=0 THEN RAISE EXCEPTION 'Unexpected retention snapshot list'; END IF;
 EXECUTE replace(original,'''inventory_control''','''inventory_product_sync'',''inventory_control''');
END $patch$;

-- Extend only the current bounded page with product status.
ALTER FUNCTION public.rpc_inventory_window(jsonb) SET SCHEMA private;
ALTER FUNCTION private.rpc_inventory_window(jsonb) RENAME TO inventory_window_v129;
REVOKE ALL ON FUNCTION private.inventory_window_v129(jsonb) FROM PUBLIC,anon,authenticated;
CREATE FUNCTION public.rpc_inventory_window(p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb; control public.inventory_control; rows_json jsonb;
BEGIN
 result:=private.inventory_window_v129(p_filters);
 SELECT * INTO control FROM public.inventory_control WHERE id;
 result:=jsonb_set(result,'{control}',(result->'control')||jsonb_build_object('syncMode',control.sync_mode,'productSyncAvailable',true));
 IF COALESCE(p_filters->>'mode','stock')='stock' THEN
   SELECT COALESCE(jsonb_agg(row.value||jsonb_build_object('sync_active',control.activated_at IS NOT NULL
     AND (control.sync_mode='all' OR s.enabled_at IS NOT NULL),'sync_started_at',s.enabled_at) ORDER BY row.ordinality),'[]'::jsonb)
   INTO rows_json FROM jsonb_array_elements(result->'rows') WITH ORDINALITY row(value,ordinality)
   LEFT JOIN public.inventory_product_sync s ON s.product_id=row.value->>'product_id';
   result:=jsonb_set(result,'{rows}',rows_json);
   WHILE octet_length(result::text)>32740 LOOP
     IF jsonb_array_length(rows_json)<=1 THEN RAISE EXCEPTION 'Dòng kho quá lớn.'; END IF;
     rows_json:=rows_json-(jsonb_array_length(rows_json)-1);
     result:=jsonb_set(jsonb_set(jsonb_set(result,'{rows}',rows_json),'{hasMore}','true'),'{nextCursor}',rows_json->(jsonb_array_length(rows_json)-1)->'product_id');
   END LOOP;
 END IF;
 result:=jsonb_set(result,'{usage,moduleBytes}',to_jsonb((result#>>'{usage,moduleBytes}')::bigint+pg_catalog.pg_total_relation_size('public.inventory_product_sync')));
 PERFORM private.inventory_charge(8192);
 SELECT * INTO control FROM public.inventory_control WHERE id;
 RETURN jsonb_set(result,'{usage,budgetUsed}',to_jsonb(control.read_budget_used));
END $$;
REVOKE ALL ON FUNCTION private.inventory_product_context(text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.rpc_inventory_count_context(text),public.rpc_inventory_count_product(jsonb),public.rpc_inventory_window(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_inventory_count_context(text),public.rpc_inventory_count_product(jsonb),public.rpc_inventory_window(jsonb) TO authenticated;
-- The reviewed deferred item trigger skips authenticated retention execution.
UPDATE public.retention_control SET expected_trigger_hash=public.p107_trigger_fingerprint() WHERE id;
INSERT INTO public.schema_migrations(version,description) VALUES('0130','Atomic per-SKU count and order synchronization with movement conflict detection');
NOTIFY pgrst,'reload schema';
COMMIT;
