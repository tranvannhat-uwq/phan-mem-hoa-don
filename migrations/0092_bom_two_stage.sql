BEGIN;

-- Two-stage BOM. No legacy recipe data is copied or activated automatically.
-- All material quantities use the item's base unit; packaged outputs use SKU units.
CREATE TABLE public.bom_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 60),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('raw', 'packaging', 'semi')),
  base_unit text NOT NULL CHECK (length(base_unit) BETWEEN 1 AND 24),
  purchase_unit text NOT NULL CHECK (length(purchase_unit) BETWEEN 1 AND 24),
  purchase_to_base numeric(18,4) NOT NULL DEFAULT 1 CHECK (purchase_to_base > 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.bom_item_balances (
  item_id uuid PRIMARY KEY REFERENCES public.bom_items(id) ON DELETE RESTRICT,
  quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.bom_item_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  request_key uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('receipt', 'issue', 'count')),
  item_id uuid NOT NULL REFERENCES public.bom_items(id) ON DELETE RESTRICT,
  request jsonb NOT NULL CHECK (octet_length(request::text) <= 2048),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id, request_key)
);
CREATE TABLE public.bom_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  output_kind text NOT NULL CHECK (output_kind IN ('semi', 'sku')),
  output_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'released', 'superseded')),
  output_quantity numeric(18,4) NOT NULL CHECK (output_quantity > 0),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 240),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE(output_kind, output_id, version)
);
CREATE UNIQUE INDEX bom_one_draft_idx ON public.bom_versions(output_kind, output_id) WHERE status = 'draft';
CREATE UNIQUE INDEX bom_one_released_idx ON public.bom_versions(output_kind, output_id) WHERE status = 'released';
CREATE TABLE public.bom_lines (
  version_id uuid NOT NULL REFERENCES public.bom_versions(id) ON DELETE RESTRICT,
  item_id uuid NOT NULL REFERENCES public.bom_items(id) ON DELETE RESTRICT,
  quantity numeric(18,4) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY(version_id, item_id)
);
CREATE TABLE public.bom_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  request_key uuid NOT NULL,
  version_id uuid NOT NULL REFERENCES public.bom_versions(id) ON DELETE RESTRICT,
  output_quantity numeric(18,4) NOT NULL CHECK (output_quantity > 0),
  request jsonb NOT NULL CHECK (octet_length(request::text) <= 2048),
  snapshot jsonb NOT NULL CHECK (octet_length(snapshot::text) <= 12000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(actor_id, request_key)
);
CREATE TABLE public.bom_item_movements (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES public.bom_items(id) ON DELETE RESTRICT,
  delta numeric(18,4) NOT NULL CHECK (delta <> 0),
  balance_after numeric(18,4) NOT NULL CHECK (balance_after >= 0),
  kind text NOT NULL CHECK (kind IN ('receipt', 'issue', 'count', 'production')),
  document_id uuid REFERENCES public.bom_item_documents(id) ON DELETE RESTRICT,
  run_id uuid REFERENCES public.bom_runs(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bom_item_movements_date_idx ON public.bom_item_movements(id DESC);
CREATE INDEX bom_item_movements_item_idx ON public.bom_item_movements(item_id, id DESC);

ALTER TABLE public.inventory_movements DROP CONSTRAINT inventory_movements_kind_check;
ALTER TABLE public.inventory_movements ADD CONSTRAINT inventory_movements_kind_check
  CHECK (kind IN ('receipt', 'issue', 'count', 'sale', 'production'));
ALTER TABLE public.inventory_movements ADD COLUMN production_run_id uuid REFERENCES public.bom_runs(id) ON DELETE RESTRICT;

ALTER TABLE public.bom_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bom_item_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bom_item_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bom_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bom_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bom_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bom_item_movements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bom_items, public.bom_item_balances, public.bom_item_documents,
  public.bom_versions, public.bom_lines, public.bom_runs, public.bom_item_movements
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.bom_item_movements_id_seq FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.inventory_guard_storage() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE used_bytes bigint;
BEGIN
  SELECT sum(pg_catalog.pg_total_relation_size(t::regclass)) INTO used_bytes
  FROM unnest(ARRAY['public.inventory_control', 'public.inventory_balances',
    'public.inventory_documents', 'public.inventory_movements',
    'public.inventory_order_positions', 'public.inventory_pending_orders',
    'public.bom_items', 'public.bom_item_balances', 'public.bom_item_documents',
    'public.bom_versions', 'public.bom_lines', 'public.bom_runs',
    'public.bom_item_movements']) AS t;
  IF used_bytes >= 63900000 OR pg_catalog.pg_database_size(current_database()) >= 399000000 THEN
    RAISE EXCEPTION 'Kho gần ngưỡng dung lượng an toàn của Free. Cần sao lưu và kiểm tra Usage trước khi ghi thêm.';
  END IF;
END $$;

CREATE FUNCTION private.bom_apply_item_delta(p_item uuid, p_delta numeric, p_kind text,
  p_document uuid, p_run uuid, p_actor uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE next_quantity numeric;
BEGIN
  IF p_delta = 0 OR p_delta <> round(p_delta, 4) THEN RAISE EXCEPTION 'Số lượng BOM không hợp lệ.'; END IF;
  PERFORM private.inventory_guard_storage();
  INSERT INTO public.bom_item_balances(item_id) VALUES (p_item) ON CONFLICT DO NOTHING;
  SELECT quantity + p_delta INTO next_quantity FROM public.bom_item_balances WHERE item_id = p_item FOR UPDATE;
  IF next_quantity < 0 THEN RAISE EXCEPTION 'Vật tư % không đủ tồn (thiếu %).', p_item, -next_quantity; END IF;
  UPDATE public.bom_item_balances SET quantity = next_quantity, updated_at = now() WHERE item_id = p_item;
  INSERT INTO public.bom_item_movements(item_id, delta, balance_after, kind, document_id, run_id, actor_id)
  VALUES (p_item, p_delta, next_quantity, p_kind, p_document, p_run, p_actor);
END $$;

-- Admin owns recipe configuration. Accounting may receive/count materials and run production.
CREATE FUNCTION public.rpc_bom_save_item(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.profiles; item_id uuid; existing public.bom_items;
BEGIN
  actor := private.inventory_require_manager();
  IF actor.role <> 'admin' THEN RAISE EXCEPTION 'Chỉ Admin được cấu hình BOM.' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.inventory_control WHERE id FOR UPDATE;
  IF jsonb_typeof(p_input) <> 'object' OR octet_length(p_input::text) > 2048 THEN RAISE EXCEPTION 'Vật tư không hợp lệ.'; END IF;
  item_id := NULLIF(p_input->>'id', '')::uuid;
  IF length(btrim(COALESCE(p_input->>'code',''))) NOT BETWEEN 1 AND 60
    OR length(btrim(COALESCE(p_input->>'name',''))) NOT BETWEEN 1 AND 120
    OR (p_input->>'kind') NOT IN ('raw','packaging','semi')
    OR length(btrim(COALESCE(p_input->>'baseUnit',''))) NOT BETWEEN 1 AND 24
    OR length(btrim(COALESCE(p_input->>'purchaseUnit',''))) NOT BETWEEN 1 AND 24
    OR (p_input->>'purchaseToBase')::numeric <= 0
    OR (p_input->>'purchaseToBase')::numeric <> round((p_input->>'purchaseToBase')::numeric,4)
    THEN RAISE EXCEPTION 'Mã, tên, loại hoặc đơn vị vật tư không hợp lệ.'; END IF;
  PERFORM private.inventory_guard_storage();
  IF item_id IS NULL THEN
    INSERT INTO public.bom_items(code,name,kind,base_unit,purchase_unit,purchase_to_base)
    VALUES (btrim(p_input->>'code'),btrim(p_input->>'name'),p_input->>'kind',btrim(p_input->>'baseUnit'),
      btrim(p_input->>'purchaseUnit'),(p_input->>'purchaseToBase')::numeric) RETURNING id INTO item_id;
  ELSE
    SELECT * INTO existing FROM public.bom_items WHERE id = item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Vật tư không tồn tại.'; END IF;
    IF (existing.kind, existing.base_unit, existing.purchase_to_base) IS DISTINCT FROM
       (p_input->>'kind', btrim(p_input->>'baseUnit'), (p_input->>'purchaseToBase')::numeric)
       AND (EXISTS (SELECT 1 FROM public.bom_item_movements WHERE bom_item_movements.item_id=item_id)
         OR EXISTS (SELECT 1 FROM public.bom_lines WHERE bom_lines.item_id=item_id)
         OR EXISTS (SELECT 1 FROM public.bom_versions WHERE output_kind='semi' AND output_id=item_id::text)) THEN
      RAISE EXCEPTION 'Vật tư đã phát sinh không thể đổi loại, đơn vị gốc hoặc hệ số.';
    END IF;
    UPDATE public.bom_items SET code=btrim(p_input->>'code'),name=btrim(p_input->>'name'),
      kind=p_input->>'kind',base_unit=btrim(p_input->>'baseUnit'),purchase_unit=btrim(p_input->>'purchaseUnit'),
      purchase_to_base=(p_input->>'purchaseToBase')::numeric,
      is_active=COALESCE((p_input->>'isActive')::boolean,true) WHERE id=item_id;
  END IF;
  PERFORM private.inventory_charge(8704);
  RETURN jsonb_build_object('id',item_id);
END $$;

CREATE FUNCTION public.rpc_bom_post_item(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.profiles; prior public.bom_item_documents; doc_id uuid; item public.bom_items;
  v_request_key uuid; kind text; quantity numeric; current_quantity numeric; delta numeric;
BEGIN
  actor := private.inventory_require_manager();
  PERFORM 1 FROM public.inventory_control WHERE id FOR UPDATE;
  IF jsonb_typeof(p_input) <> 'object' OR octet_length(p_input::text) > 2048 THEN RAISE EXCEPTION 'Phiếu vật tư không hợp lệ.'; END IF;
  v_request_key := (p_input->>'requestKey')::uuid; kind := p_input->>'kind';
  IF v_request_key IS NULL OR kind NOT IN ('receipt','issue','count') THEN RAISE EXCEPTION 'Phiếu vật tư không hợp lệ.'; END IF;
  SELECT * INTO prior FROM public.bom_item_documents d WHERE d.actor_id=actor.auth_user_id AND d.request_key=v_request_key;
  IF FOUND THEN
    IF prior.request IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng cho phiếu khác.'; END IF;
    PERFORM private.inventory_charge(8704);
    RETURN jsonb_build_object('id',prior.id,'replayed',true);
  END IF;
  SELECT * INTO item FROM public.bom_items WHERE id=(p_input->>'itemId')::uuid AND is_active FOR UPDATE;
  IF NOT FOUND OR item.kind='semi' AND kind='receipt' THEN RAISE EXCEPTION 'Vật tư không tồn tại hoặc bán thành phẩm chỉ nhập qua sản xuất.'; END IF;
  quantity := (p_input->>'quantity')::numeric;
  IF quantity IS NULL OR quantity < 0 OR quantity > 100000000 OR quantity <> round(quantity,4)
     OR (kind <> 'count' AND quantity=0) THEN RAISE EXCEPTION 'Số lượng vật tư không hợp lệ.'; END IF;
  IF kind='receipt' AND COALESCE(p_input->>'unit','base')='purchase' THEN
    quantity := quantity * item.purchase_to_base;
    IF quantity <> round(quantity,4) THEN RAISE EXCEPTION 'Quy đổi vượt 4 chữ số thập phân.'; END IF;
  ELSIF COALESCE(p_input->>'unit','base') <> 'base' THEN RAISE EXCEPTION 'Đơn vị không hợp lệ.'; END IF;
  INSERT INTO public.bom_item_balances(item_id) VALUES (item.id) ON CONFLICT DO NOTHING;
  SELECT b.quantity INTO current_quantity FROM public.bom_item_balances b WHERE b.item_id=item.id FOR UPDATE;
  IF kind='count' THEN
    IF (p_input->>'expectedQuantity')::numeric IS DISTINCT FROM current_quantity THEN RAISE EXCEPTION 'Tồn vật tư đã thay đổi. Tải lại trước khi kiểm kê.'; END IF;
    delta := quantity-current_quantity;
  ELSE delta := CASE WHEN kind='issue' THEN -quantity ELSE quantity END; END IF;
  PERFORM private.inventory_guard_storage();
  INSERT INTO public.bom_item_documents(actor_id,request_key,kind,item_id,request)
  VALUES(actor.auth_user_id,v_request_key,kind,item.id,p_input) RETURNING id INTO doc_id;
  IF delta <> 0 THEN PERFORM private.bom_apply_item_delta(item.id,delta,kind,doc_id,NULL,actor.auth_user_id); END IF;
  PERFORM private.inventory_charge(8704);
  RETURN jsonb_build_object('id',doc_id,'replayed',false);
END $$;

CREATE FUNCTION public.rpc_bom_save_draft(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.profiles; draft public.bom_versions; v_output_kind text; v_output_id text;
  v_version_id uuid; v_output_quantity numeric; line jsonb; component public.bom_items;
  line_count integer; semi_count integer := 0;
BEGIN
  actor := private.inventory_require_manager();
  IF actor.role <> 'admin' THEN RAISE EXCEPTION 'Chỉ Admin được cấu hình BOM.' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.inventory_control WHERE id FOR UPDATE;
  IF jsonb_typeof(p_input) <> 'object' OR octet_length(p_input::text) > 12000
     OR jsonb_typeof(p_input->'lines') <> 'array' THEN RAISE EXCEPTION 'Cấu hình BOM không hợp lệ.'; END IF;
  v_output_kind:=p_input->>'outputKind'; v_output_id:=p_input->>'outputId';
  v_output_quantity:=(p_input->>'outputQuantity')::numeric;
  line_count:=jsonb_array_length(p_input->'lines');
  IF v_output_kind NOT IN ('semi','sku') OR v_output_id IS NULL OR length(v_output_id)>100
    OR v_output_quantity IS NULL OR v_output_quantity<=0 OR v_output_quantity>100000000
    OR v_output_quantity<>round(v_output_quantity,4) OR line_count NOT BETWEEN 1 AND 30
    OR length(COALESCE(p_input->>'note',''))>240 THEN RAISE EXCEPTION 'Đầu ra hoặc định mức BOM không hợp lệ.'; END IF;
  IF v_output_kind='semi' THEN
    IF NOT EXISTS(SELECT 1 FROM public.bom_items WHERE id=v_output_id::uuid AND kind='semi' AND is_active)
       THEN RAISE EXCEPTION 'Bán thành phẩm đầu ra không hợp lệ.'; END IF;
  ELSIF NOT EXISTS(SELECT 1 FROM public.products WHERE id=v_output_id AND is_active AND NOT is_legacy
    AND COALESCE(NULLIF(packaging_name,''),NULLIF(package_type,'')) IS NOT NULL)
    THEN RAISE EXCEPTION 'SKU đầu ra không hợp lệ.'; END IF;
  SELECT * INTO draft FROM public.bom_versions v WHERE v.output_kind=v_output_kind
    AND v.output_id=v_output_id AND v.status='draft' FOR UPDATE;
  IF FOUND THEN v_version_id:=draft.id;
  ELSE
    INSERT INTO public.bom_versions(output_kind,output_id,version,output_quantity,note,created_by)
    VALUES(v_output_kind,v_output_id,
      COALESCE((SELECT max(version)+1 FROM public.bom_versions v WHERE v.output_kind=v_output_kind AND v.output_id=v_output_id),1),
      v_output_quantity,COALESCE(p_input->>'note',''),actor.auth_user_id) RETURNING id INTO v_version_id;
  END IF;
  PERFORM private.inventory_guard_storage();
  DELETE FROM public.bom_lines l WHERE l.version_id=v_version_id;
  FOR line IN SELECT value FROM jsonb_array_elements(p_input->'lines') LOOP
    SELECT * INTO component FROM public.bom_items WHERE id=(line->>'itemId')::uuid AND is_active;
    IF NOT FOUND OR v_output_kind='semi' AND component.kind<>'raw'
       OR v_output_kind='sku' AND component.kind NOT IN ('semi','packaging') THEN
      RAISE EXCEPTION 'Thành phần BOM không đúng công đoạn.';
    END IF;
    IF component.kind='semi' THEN semi_count:=semi_count+1; END IF;
    IF (line->>'quantity')::numeric IS NULL OR (line->>'quantity')::numeric<=0
       OR (line->>'quantity')::numeric>100000000
       OR (line->>'quantity')::numeric<>round((line->>'quantity')::numeric,4)
       THEN RAISE EXCEPTION 'Định mức thành phần không hợp lệ.'; END IF;
    INSERT INTO public.bom_lines(version_id,item_id,quantity)
    VALUES(v_version_id,component.id,(line->>'quantity')::numeric);
  END LOOP;
  IF v_output_kind='sku' AND semi_count=0 THEN RAISE EXCEPTION 'BOM đóng gói cần ít nhất một bán thành phẩm.'; END IF;
  UPDATE public.bom_versions SET output_quantity=v_output_quantity,
    note=COALESCE(p_input->>'note','') WHERE id=v_version_id;
  PERFORM private.inventory_charge(8704);
  RETURN jsonb_build_object('id',v_version_id,'status','draft');
END $$;

CREATE FUNCTION public.rpc_bom_publish(p_version_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.profiles; recipe public.bom_versions;
BEGIN
  actor:=private.inventory_require_manager();
  IF actor.role<>'admin' THEN RAISE EXCEPTION 'Chỉ Admin được áp dụng BOM.' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.inventory_control WHERE id FOR UPDATE;
  SELECT * INTO recipe FROM public.bom_versions WHERE id=p_version_id FOR UPDATE;
  IF NOT FOUND OR recipe.status<>'draft' THEN RAISE EXCEPTION 'Chỉ áp dụng phiên bản nháp.'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.bom_lines WHERE version_id=p_version_id) THEN RAISE EXCEPTION 'BOM chưa có thành phần.'; END IF;
  IF recipe.output_kind='semi' AND NOT EXISTS(SELECT 1 FROM public.bom_items WHERE id=recipe.output_id::uuid AND is_active)
    OR recipe.output_kind='sku' AND NOT EXISTS(SELECT 1 FROM public.products WHERE id=recipe.output_id AND is_active AND NOT is_legacy)
    OR EXISTS(SELECT 1 FROM public.bom_lines l JOIN public.bom_items i ON i.id=l.item_id
      WHERE l.version_id=p_version_id AND NOT i.is_active) THEN
    RAISE EXCEPTION 'BOM có đầu ra hoặc thành phần đã ngừng sử dụng.';
  END IF;
  PERFORM private.inventory_guard_storage();
  UPDATE public.bom_versions SET status='superseded'
    WHERE output_kind=recipe.output_kind AND output_id=recipe.output_id AND status='released';
  UPDATE public.bom_versions SET status='released',published_at=now() WHERE id=p_version_id;
  PERFORM private.inventory_charge(8704);
  RETURN jsonb_build_object('id',p_version_id,'status','released');
END $$;

CREATE FUNCTION public.rpc_bom_run(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.profiles; prior public.bom_runs; recipe public.bom_versions;
  v_request_key uuid; run_id uuid; actual_quantity numeric; required numeric; component record;
  details jsonb; snapshot jsonb;
BEGIN
  actor:=private.inventory_require_manager();
  PERFORM 1 FROM public.inventory_control WHERE id FOR UPDATE;
  IF jsonb_typeof(p_input)<>'object' OR octet_length(p_input::text)>2048 THEN RAISE EXCEPTION 'Lệnh sản xuất không hợp lệ.'; END IF;
  v_request_key:=(p_input->>'requestKey')::uuid;
  IF v_request_key IS NULL THEN RAISE EXCEPTION 'Thiếu mã yêu cầu.'; END IF;
  SELECT * INTO prior FROM public.bom_runs r WHERE r.actor_id=actor.auth_user_id AND r.request_key=v_request_key;
  IF FOUND THEN
    IF prior.request IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'Mã yêu cầu đã dùng cho lệnh khác.'; END IF;
    PERFORM private.inventory_charge(8704);
    RETURN jsonb_build_object('id',prior.id,'replayed',true);
  END IF;
  SELECT * INTO recipe FROM public.bom_versions WHERE id=(p_input->>'versionId')::uuid AND status='released' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOM chưa áp dụng hoặc đã thay thế.'; END IF;
  IF recipe.output_kind='semi' AND NOT EXISTS(SELECT 1 FROM public.bom_items WHERE id=recipe.output_id::uuid AND is_active)
    OR recipe.output_kind='sku' AND NOT EXISTS(SELECT 1 FROM public.products WHERE id=recipe.output_id AND is_active AND NOT is_legacy)
    OR EXISTS(SELECT 1 FROM public.bom_lines l JOIN public.bom_items i ON i.id=l.item_id
      WHERE l.version_id=recipe.id AND NOT i.is_active) THEN
    RAISE EXCEPTION 'BOM có đầu ra hoặc thành phần đã ngừng sử dụng.';
  END IF;
  actual_quantity:=(p_input->>'quantity')::numeric;
  IF actual_quantity IS NULL OR actual_quantity<=0 OR actual_quantity>100000000
    OR actual_quantity<>round(actual_quantity,4) THEN RAISE EXCEPTION 'Sản lượng không hợp lệ.'; END IF;
  SELECT jsonb_agg(jsonb_build_object('itemId',l.item_id,'code',i.code,'kind',i.kind,
    'unit',i.base_unit,'quantity',l.quantity) ORDER BY i.id) INTO details
    FROM public.bom_lines l JOIN public.bom_items i ON i.id=l.item_id WHERE l.version_id=recipe.id;
  IF details IS NULL THEN RAISE EXCEPTION 'BOM chưa có thành phần.'; END IF;
  snapshot:=jsonb_build_object('version',recipe.version,'outputKind',recipe.output_kind,
    'outputId',recipe.output_id,'batchQuantity',recipe.output_quantity,'lines',details);
  PERFORM private.inventory_guard_storage();
  INSERT INTO public.bom_runs(actor_id,request_key,version_id,output_quantity,request,snapshot)
  VALUES(actor.auth_user_id,v_request_key,recipe.id,actual_quantity,p_input,snapshot) RETURNING id INTO run_id;
  FOR component IN SELECT l.item_id,l.quantity FROM public.bom_lines l WHERE l.version_id=recipe.id ORDER BY l.item_id LOOP
    required:=component.quantity*actual_quantity/recipe.output_quantity;
    IF required<>round(required,4) THEN RAISE EXCEPTION 'Sản lượng làm phát sinh định mức quá 4 chữ số thập phân.'; END IF;
    PERFORM private.bom_apply_item_delta(component.item_id,-required,'production',NULL,run_id,actor.auth_user_id);
  END LOOP;
  IF recipe.output_kind='semi' THEN
    PERFORM private.bom_apply_item_delta(recipe.output_id::uuid,actual_quantity,'production',NULL,run_id,actor.auth_user_id);
  ELSE
    PERFORM private.inventory_apply_delta(recipe.output_id,actual_quantity,'production',NULL,NULL,actor.auth_user_id);
    UPDATE public.inventory_movements SET production_run_id=run_id
      WHERE id=(SELECT max(id) FROM public.inventory_movements WHERE product_id=recipe.output_id AND kind='production' AND actor_id=actor.auth_user_id);
  END IF;
  PERFORM private.inventory_charge(8704);
  RETURN jsonb_build_object('id',run_id,'replayed',false,'quantity',actual_quantity);
END $$;

-- One bounded, budgeted RPC. Detail mode loads a single BOM only when opened.
CREATE FUNCTION public.rpc_bom_window(p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.profiles; mode text; cursor_text text; query_text text; page_limit integer;
  rows_json jsonb; result jsonb; has_more boolean; charge bigint; detail_id uuid;
BEGIN
  actor:=private.inventory_require_manager();
  IF jsonb_typeof(p_filters)<>'object' OR octet_length(p_filters::text)>2048 THEN RAISE EXCEPTION 'Bộ lọc BOM không hợp lệ.'; END IF;
  mode:=COALESCE(p_filters->>'mode','items'); cursor_text:=NULLIF(p_filters->>'cursor','');
  query_text:=left(COALESCE(p_filters->>'query',''),80);
  page_limit:=COALESCE((p_filters->>'limit')::integer,15);
  IF page_limit NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'Mỗi trang BOM cần 1–30 dòng.'; END IF;
  IF NULLIF(p_filters->>'kind','') IS NOT NULL AND p_filters->>'kind' NOT IN ('raw','packaging','semi')
    THEN RAISE EXCEPTION 'Loại vật tư không hợp lệ.'; END IF;
  IF mode='items' THEN
    WITH candidates AS (SELECT i.id,i.code,i.name,i.kind,i.base_unit,i.purchase_unit,i.purchase_to_base,
      i.is_active,COALESCE(b.quantity,0) AS quantity FROM public.bom_items i
      LEFT JOIN public.bom_item_balances b ON b.item_id=i.id
      WHERE (cursor_text IS NULL OR i.code>cursor_text)
        AND (NULLIF(p_filters->>'kind','') IS NULL OR i.kind=p_filters->>'kind')
        AND (query_text='' OR lower(i.code||' '||i.name) LIKE '%'||lower(query_text)||'%')
      ORDER BY i.code LIMIT page_limit+1)
    SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY code),'[]'::jsonb) INTO rows_json FROM candidates c;
  ELSIF mode='skus' THEN
    WITH candidates AS (SELECT p.id,p.code,p.name,p.brand,
      COALESCE(NULLIF(p.packaging_name,''),p.package_type) AS unit FROM public.products p
      WHERE p.is_active AND NOT p.is_legacy
        AND COALESCE(NULLIF(p.packaging_name,''),NULLIF(p.package_type,'')) IS NOT NULL
        AND (cursor_text IS NULL OR p.id>cursor_text)
        AND (query_text='' OR lower(p.code||' '||p.name||' '||p.brand) LIKE '%'||lower(query_text)||'%')
      ORDER BY p.id LIMIT page_limit+1)
    SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id),'[]'::jsonb) INTO rows_json FROM candidates c;
  ELSIF mode='recipes' THEN
    WITH candidates AS (SELECT v.id,v.output_kind,v.output_id,v.version,v.status,v.output_quantity,
      v.note,v.published_at,COALESCE(i.name,p.name,'') AS output_name
      FROM public.bom_versions v LEFT JOIN public.bom_items i ON v.output_kind='semi' AND i.id::text=v.output_id
      LEFT JOIN public.products p ON v.output_kind='sku' AND p.id=v.output_id
      WHERE (cursor_text IS NULL OR v.id::text>cursor_text)
        AND (query_text='' OR lower(v.output_id||' '||COALESCE(i.name,p.name,'')) LIKE '%'||lower(query_text)||'%')
      ORDER BY v.id LIMIT page_limit+1)
    SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id),'[]'::jsonb) INTO rows_json FROM candidates c;
  ELSIF mode='runs' THEN
    WITH candidates AS (SELECT r.id,r.created_at,r.output_quantity,r.version_id,
      r.snapshot->>'outputKind' AS output_kind,r.snapshot->>'outputId' AS output_id,
      r.snapshot->>'version' AS version FROM public.bom_runs r
      WHERE (cursor_text IS NULL OR (r.created_at,r.id)<
        (split_part(cursor_text,'|',1)::timestamptz,split_part(cursor_text,'|',2)::uuid))
      ORDER BY r.created_at DESC,r.id DESC LIMIT page_limit+1)
    SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY created_at DESC,id DESC),'[]'::jsonb) INTO rows_json FROM candidates c;
  ELSIF mode='detail' THEN
    detail_id:=(p_filters->>'id')::uuid;
    SELECT jsonb_build_array(jsonb_build_object('id',v.id,'outputKind',v.output_kind,
      'outputId',v.output_id,'outputQuantity',v.output_quantity,'version',v.version,'status',v.status,
      'note',v.note,'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('itemId',l.item_id,
      'code',i.code,'name',i.name,'kind',i.kind,'unit',i.base_unit,'quantity',l.quantity) ORDER BY i.code)
        FROM public.bom_lines l JOIN public.bom_items i ON i.id=l.item_id WHERE l.version_id=v.id),'[]'::jsonb)))
    INTO rows_json FROM public.bom_versions v WHERE v.id=detail_id;
    rows_json:=COALESCE(rows_json,'[]'::jsonb);
  ELSIF mode='runDetail' THEN
    detail_id:=(p_filters->>'id')::uuid;
    SELECT jsonb_build_array(jsonb_build_object('id',r.id,'createdAt',r.created_at,
      'quantity',r.output_quantity,'snapshot',r.snapshot)) INTO rows_json
      FROM public.bom_runs r WHERE r.id=detail_id;
    rows_json:=COALESCE(rows_json,'[]'::jsonb);
  ELSE RAISE EXCEPTION 'Chế độ BOM không hợp lệ.'; END IF;
  has_more:=jsonb_array_length(rows_json)>page_limit;
  IF has_more THEN rows_json:=rows_json-page_limit; END IF;
  result:=jsonb_build_object('rows',rows_json,'hasMore',has_more,'nextCursor',
    CASE WHEN has_more THEN CASE WHEN mode='runs' THEN
      (rows_json->(page_limit-1)->>'created_at')||'|'||(rows_json->(page_limit-1)->>'id')
      ELSE rows_json->(page_limit-1)->>CASE WHEN mode='items' THEN 'code' ELSE 'id' END END ELSE NULL END);
  WHILE octet_length(result::text)>32740 LOOP
    IF jsonb_array_length(rows_json)<=1 THEN RAISE EXCEPTION 'Một dòng BOM quá lớn.'; END IF;
    rows_json:=rows_json-(jsonb_array_length(rows_json)-1);
    result:=jsonb_set(result,'{rows}',rows_json);
    result:=jsonb_set(result,'{hasMore}','true'::jsonb);
    result:=jsonb_set(result,'{nextCursor}',to_jsonb(CASE WHEN mode='runs' THEN
      (rows_json->(jsonb_array_length(rows_json)-1)->>'created_at')||'|'||(rows_json->(jsonb_array_length(rows_json)-1)->>'id')
      ELSE rows_json->(jsonb_array_length(rows_json)-1)->>CASE WHEN mode='items' THEN 'code' ELSE 'id' END END));
  END LOOP;
  charge:=octet_length(result::text)*2+8192;
  PERFORM private.inventory_charge(charge);
  RETURN result;
END $$;

-- Keep the existing bounded SKU query and sync metadata, but show combined
-- SKU/BOM storage in the inventory status card. The prior charge includes a
-- conservative 8 KiB envelope, far larger than this numeric field change.
ALTER FUNCTION public.rpc_inventory_window(jsonb) SET SCHEMA private;
ALTER FUNCTION private.rpc_inventory_window(jsonb) RENAME TO inventory_window_v89;
REVOKE ALL ON FUNCTION private.inventory_window_v89(jsonb) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.rpc_inventory_window(p_filters jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE result jsonb; module_bytes bigint;
BEGIN
  result:=private.inventory_window_v89(p_filters);
  SELECT sum(pg_catalog.pg_total_relation_size(t::regclass)) INTO module_bytes
  FROM unnest(ARRAY['public.inventory_control', 'public.inventory_balances',
    'public.inventory_documents', 'public.inventory_movements',
    'public.inventory_order_positions', 'public.inventory_pending_orders',
    'public.bom_items', 'public.bom_item_balances', 'public.bom_item_documents',
    'public.bom_versions', 'public.bom_lines', 'public.bom_runs',
    'public.bom_item_movements']) AS t;
  RETURN jsonb_set(result,'{usage,moduleBytes}',to_jsonb(module_bytes));
END $$;
REVOKE ALL ON FUNCTION public.rpc_inventory_window(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_inventory_window(jsonb) TO authenticated;

REVOKE ALL ON FUNCTION private.bom_apply_item_delta(uuid,numeric,text,uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_bom_save_item(jsonb), public.rpc_bom_post_item(jsonb),
  public.rpc_bom_save_draft(jsonb), public.rpc_bom_publish(uuid), public.rpc_bom_run(jsonb),
  public.rpc_bom_window(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_bom_save_item(jsonb), public.rpc_bom_post_item(jsonb),
  public.rpc_bom_save_draft(jsonb), public.rpc_bom_publish(uuid), public.rpc_bom_run(jsonb),
  public.rpc_bom_window(jsonb) TO authenticated;
INSERT INTO public.schema_migrations(version,description)
VALUES ('0092', 'Two-stage versioned BOM and atomic production');
COMMIT;
