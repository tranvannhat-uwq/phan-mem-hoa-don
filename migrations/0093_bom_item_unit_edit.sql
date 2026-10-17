BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0092')
     OR pg_catalog.to_regprocedure('public.rpc_bom_save_item(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Migration 0093 stopped: apply BOM migration 0092 first.';
  END IF;
END $$;

-- Repair the item update path and keep unit changes safe. Existing stock,
-- movements, BOM inputs, and semi-finished outputs all lock the base unit.
CREATE OR REPLACE FUNCTION public.rpc_bom_save_iteAm(p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE actor public.profiles; v_item_id uuid; existing public.bom_items;
BEGIN
  actor := private.inventory_require_manager();
  IF actor.role <> 'admin' THEN RAISE EXCEPTION 'Chỉ Admin được cấu hình BOM.' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.inventory_control WHERE id FOR UPDATE;
  IF jsonb_typeof(p_input) <> 'object' OR octet_length(p_input::text) > 2048 THEN RAISE EXCEPTION 'Vật tư không hợp lệ.'; END IF;
  v_item_id := NULLIF(p_input->>'id', '')::uuid;
  IF length(btrim(COALESCE(p_input->>'code',''))) NOT BETWEEN 1 AND 60
    OR length(btrim(COALESCE(p_input->>'name',''))) NOT BETWEEN 1 AND 120
    OR (p_input->>'kind') NOT IN ('raw','packaging','semi')
    OR length(btrim(COALESCE(p_input->>'baseUnit',''))) NOT BETWEEN 1 AND 24
    OR length(btrim(COALESCE(p_input->>'purchaseUnit',''))) NOT BETWEEN 1 AND 24
    OR (p_input->>'purchaseToBase')::numeric <= 0
    OR (p_input->>'purchaseToBase')::numeric <> round((p_input->>'purchaseToBase')::numeric,4)
    THEN RAISE EXCEPTION 'Mã, tên, loại hoặc đơn vị vật tư không hợp lệ.'; END IF;
  PERFORM private.inventory_guard_storage();
  IF v_item_id IS NULL THEN
    INSERT INTO public.bom_items(code,name,kind,base_unit,purchase_unit,purchase_to_base)
    VALUES (btrim(p_input->>'code'),btrim(p_input->>'name'),p_input->>'kind',btrim(p_input->>'baseUnit'),
      btrim(p_input->>'purchaseUnit'),(p_input->>'purchaseToBase')::numeric) RETURNING id INTO v_item_id;
  ELSE
    SELECT i.* INTO existing FROM public.bom_items AS i WHERE i.id = v_item_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Vật tư không tồn tại.'; END IF;
    IF (existing.kind, existing.base_unit, existing.purchase_to_base) IS DISTINCT FROM
       (p_input->>'kind', btrim(p_input->>'baseUnit'), (p_input->>'purchaseToBase')::numeric)
       AND (EXISTS (SELECT 1 FROM public.bom_item_balances AS b WHERE b.item_id = v_item_id AND b.quantity <> 0)
         OR EXISTS (SELECT 1 FROM public.bom_item_movements AS m WHERE m.item_id = v_item_id)
         OR EXISTS (SELECT 1 FROM public.bom_lines AS l WHERE l.item_id = v_item_id)
         OR EXISTS (SELECT 1 FROM public.bom_versions AS v WHERE v.output_kind = 'semi' AND v.output_id = v_item_id::text)) THEN
      RAISE EXCEPTION 'Vật tư đã phát sinh hoặc đang có tồn, không thể đổi loại, đơn vị gốc hoặc hệ số.';
    END IF;
    UPDATE public.bom_items AS i SET code=btrim(p_input->>'code'),name=btrim(p_input->>'name'),
      kind=p_input->>'kind',base_unit=btrim(p_input->>'baseUnit'),purchase_unit=btrim(p_input->>'purchaseUnit'),
      purchase_to_base=(p_input->>'purchaseToBase')::numeric,
      is_active=COALESCE((p_input->>'isActive')::boolean,true) WHERE i.id=v_item_id;
  END IF;
  PERFORM private.inventory_charge(8704);
  RETURN jsonb_build_object('id',v_item_id);
END $$;

REVOKE ALL ON FUNCTION public.rpc_bom_save_item(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_bom_save_item(jsonb) TO authenticated;
INSERT INTO public.schema_migrations(version, description)
VALUES ('0093', 'Repair safe BOM item and base unit updates');
COMMIT;
