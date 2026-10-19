BEGIN;

-- Keep financial ledger rows append-only. A deleted order adjustment is an
-- audited in-place order amendment back to its saved prior snapshot; both the
-- adjustment and its compensating rows are then marked as a void display pair.
ALTER TABLE public.order_amendments
  ADD COLUMN IF NOT EXISTS reverses_amendment_id text,
  ADD COLUMN IF NOT EXISTS reversed_by_amendment_id text,
  ADD COLUMN IF NOT EXISTS reversal_reason text,
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz,
  ADD COLUMN IF NOT EXISTS reversed_by text;

CREATE INDEX IF NOT EXISTS order_amendments_reversal_lookup_idx
  ON public.order_amendments(reversed_by_amendment_id)
  WHERE reversed_by_amendment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.customer_debt_amendment_voids (
  ledger_id text PRIMARY KEY,
  customer_id text NOT NULL,
  target_amendment_id text NOT NULL,
  reversal_amendment_id text NOT NULL,
  reason text NOT NULL,
  performed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_debt_amendment_voids_ledger_fk
    FOREIGN KEY (ledger_id) REFERENCES public.customer_debt_transactions(id) ON DELETE RESTRICT,
  CONSTRAINT customer_debt_amendment_voids_target_fk
    FOREIGN KEY (target_amendment_id) REFERENCES public.order_amendments(id) ON DELETE RESTRICT,
  CONSTRAINT customer_debt_amendment_voids_reversal_fk
    FOREIGN KEY (reversal_amendment_id) REFERENCES public.order_amendments(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS customer_debt_amendment_voids_customer_idx
  ON public.customer_debt_amendment_voids(customer_id, created_at DESC);

ALTER TABLE public.customer_debt_amendment_voids ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_debt_amendment_voids_scoped_select
  ON public.customer_debt_amendment_voids;
CREATE POLICY customer_debt_amendment_voids_scoped_select
  ON public.customer_debt_amendment_voids
  FOR SELECT TO authenticated
  USING (
    public.current_profile_role() IN ('admin', 'accounting')
    OR (public.current_profile_role() = 'sale' AND public.can_access_customer(customer_id))
  );
REVOKE ALL ON TABLE public.customer_debt_amendment_voids FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.customer_debt_amendment_voids TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.customer_debt_amendment_voids FROM authenticated;

CREATE OR REPLACE FUNCTION public.p98_order_item_financial_signature(p_items jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'product_id', COALESCE(item->>'variantId', item->>'productId', item->>'variant_id', item->>'product_id'),
        'product_name', COALESCE(item->>'productName', item->>'product_name', item->>'product_name_snapshot', ''),
        'variant_code', COALESCE(item->>'variantCode', item->>'variant_code', item->>'productCode', item->>'product_code', ''),
        'brand_id', COALESCE(item->>'brandId', item->>'brand_id', ''),
        'packaging', COALESCE(item->>'packagingName', item->>'package', item->>'packaging_name', ''),
        'specification', COALESCE(item->>'specificationSnapshot', item->>'specification_snapshot', ''),
        'quantity', NULLIF(COALESCE(item->>'quantity', ''), '')::numeric,
        'unit_price', NULLIF(COALESCE(item->>'unitPrice', item->>'price', item->>'unit_price', ''), '')::numeric,
        'price_list_id', COALESCE(item->>'priceListId', item->>'price_list_id', ''),
        'price_source', COALESCE(item->>'priceSource', item->>'price_source', ''),
        'color_code', COALESCE(item->>'colorCode', item->>'color_code', ''),
        'discount_type', COALESCE(item->>'discountType', item->>'discount_type', 'percent'),
        'discount_value', NULLIF(COALESCE(item->>'discountValue', item->>'discount_value', item->>'discountPercent', item->>'discount_percent', ''), '')::numeric,
        'line_total', NULLIF(COALESCE(item->>'lineTotal', item->>'line_total', ''), '')::numeric
      ) ORDER BY item_order
    ), '[]'::jsonb
  )
  FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS rows(item, item_order)
$$;
REVOKE ALL ON FUNCTION public.p98_order_item_financial_signature(jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpc_get_revertible_order_amendments(
  p_customer_id text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  result jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RETURN '[]'::jsonb;
  END IF;
  IF NULLIF(btrim(p_customer_id), '') IS NULL THEN
    RETURN '[]'::jsonb;
  END IF;

  SELECT COALESCE(jsonb_agg(candidate.ledger_id ORDER BY candidate.created_at DESC, candidate.ledger_id), '[]'::jsonb)
  INTO result
  FROM (
    SELECT ledger.id AS ledger_id, ledger.created_at
    FROM public.order_amendments amendment
    JOIN public.orders sale ON sale.id = amendment.order_id
    JOIN public.customer_debt_transactions ledger
      ON ledger.order_id = amendment.order_id
     AND ledger.transaction_type = 'order_amend'
     AND ledger.customer_id = p_customer_id
    WHERE amendment.order_id = sale.id
      AND amendment.id = (
        SELECT latest.id
        FROM public.order_amendments latest
        WHERE latest.order_id = amendment.order_id
        ORDER BY latest.created_at DESC, latest.id DESC
        LIMIT 1
      )
      AND amendment.reverses_amendment_id IS NULL
      AND amendment.reversed_by_amendment_id IS NULL
      AND sale.status = 'settled'
      AND sale.customer_id IS NOT DISTINCT FROM NULLIF(amendment.new_data->>'customer_id', '')
      AND sale.customer_name IS NOT DISTINCT FROM amendment.new_data->>'customer_name'
      AND sale.items IS NOT DISTINCT FROM amendment.new_data->'items'
      AND sale.order_date IS NOT DISTINCT FROM NULLIF(amendment.new_data->>'order_date', '')::timestamptz
      AND round(COALESCE(sale.total_payable, 0)) IS NOT DISTINCT FROM round(NULLIF(amendment.new_data->>'total_payable', '')::numeric)
      AND NOT EXISTS (
        SELECT 1 FROM public.customer_debt_amendment_voids voided
        WHERE voided.ledger_id = ledger.id
      )
      AND ledger.id = ANY(ARRAY[
        'DTX-' || amendment.id,
        'DTX-OAM-OUT-' || amendment.order_id || '-' || right(amendment.id, 4),
        'DTX-OAM-IN-' || amendment.order_id || '-' || right(amendment.id, 4)
      ])
      AND NOT EXISTS (
        SELECT 1 FROM public.sales_returns sale_return
        WHERE COALESCE(sale_return.sale_id, sale_return.order_id) = sale.id
          AND sale_return.status NOT IN ('cancelled', 'canceled', 'draft')
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.payments payment
        WHERE payment.order_id = sale.id AND payment.status = 'completed'
      )
  ) candidate;

  RETURN COALESCE(result, '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_revert_order_amendment(
  p_ledger_id text,
  p_reason text DEFAULT 'Hoàn tác theo yêu cầu từ lịch sử công nợ'
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  target public.customer_debt_transactions%ROWTYPE;
  sale public.orders%ROWTYPE;
  amendment public.order_amendments%ROWTYPE;
  restored public.orders%ROWTYPE;
  rpc_result jsonb;
  restore_input jsonb;
  restore_reason text;
  revision_suffix text;
  target_ids text[];
  reversal_ids text[];
  all_ledger_ids text[];
  affected_customer_ids text[];
  manual_pricing boolean;
  use_global_override boolean;
  reversal_amendment_id text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: chỉ Admin hoặc Kế toán được hoàn tác điều chỉnh đơn'
      USING ERRCODE = '42501';
  END IF;
  IF NULLIF(btrim(p_ledger_id), '') IS NULL THEN
    RAISE EXCEPTION 'Thiếu mã bút toán điều chỉnh cần hoàn tác';
  END IF;
  restore_reason := COALESCE(NULLIF(btrim(p_reason), ''), 'Hoàn tác theo yêu cầu từ lịch sử công nợ');
  IF length(restore_reason) < 3 THEN
    RAISE EXCEPTION 'Lý do hoàn tác cần ít nhất 3 ký tự';
  END IF;

  SELECT * INTO STRICT target
  FROM public.customer_debt_transactions ledger
  WHERE ledger.id = p_ledger_id
    AND ledger.transaction_type = 'order_amend'
    AND ledger.order_id IS NOT NULL;

  PERFORM pg_advisory_xact_lock(hashtextextended('order-amend:' || target.order_id, 0));
  SELECT * INTO STRICT sale
  FROM public.orders order_row
  WHERE order_row.id = target.order_id
  FOR UPDATE;

  SELECT * INTO STRICT amendment
  FROM public.order_amendments history
  WHERE history.order_id = target.order_id
  ORDER BY history.created_at DESC, history.id DESC
  LIMIT 1
  FOR UPDATE;

  revision_suffix := right(amendment.id, 4);
  target_ids := ARRAY[
    'DTX-' || amendment.id,
    'DTX-OAM-OUT-' || amendment.order_id || '-' || revision_suffix,
    'DTX-OAM-IN-' || amendment.order_id || '-' || revision_suffix
  ];
  IF target.id <> ALL(target_ids)
     OR target.customer_id IS DISTINCT FROM NULLIF(amendment.old_data->>'customer_id', '')
       AND target.customer_id IS DISTINCT FROM NULLIF(amendment.new_data->>'customer_id', '') THEN
    RAISE EXCEPTION 'Chỉ có thể hoàn tác điều chỉnh công nợ mới nhất của hóa đơn';
  END IF;
  IF amendment.reverses_amendment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Dòng này đã hoàn tác một lần sửa trước đó và không thể xóa tiếp trong lịch sử';
  END IF;
  IF amendment.reversed_by_amendment_id IS NOT NULL
     OR EXISTS (
       SELECT 1 FROM public.customer_debt_amendment_voids voided
       WHERE voided.ledger_id = target.id
     ) THEN
    RAISE EXCEPTION 'Điều chỉnh này đã được hoàn tác';
  END IF;
  IF sale.status <> 'settled'
     OR sale.customer_id IS DISTINCT FROM NULLIF(amendment.new_data->>'customer_id', '')
     OR sale.customer_name IS DISTINCT FROM amendment.new_data->>'customer_name'
     OR sale.items IS DISTINCT FROM amendment.new_data->'items'
     OR sale.order_date IS DISTINCT FROM NULLIF(amendment.new_data->>'order_date', '')::timestamptz
     OR round(COALESCE(sale.total_payable, 0)) IS DISTINCT FROM round(NULLIF(amendment.new_data->>'total_payable', '')::numeric) THEN
    RAISE EXCEPTION 'Hóa đơn đã thay đổi sau lần điều chỉnh; hãy tải lại và kiểm tra lịch sử';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sales_returns sale_return
    WHERE COALESCE(sale_return.sale_id, sale_return.order_id) = sale.id
      AND sale_return.status NOT IN ('cancelled', 'canceled', 'draft')
  ) THEN
    RAISE EXCEPTION 'Không thể hoàn tác hóa đơn đã có phiếu trả hàng còn hiệu lực';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payments payment
    WHERE payment.order_id = sale.id AND payment.status = 'completed'
  ) THEN
    RAISE EXCEPTION 'Không thể hoàn tác khi hóa đơn đã có phiếu thu liên kết';
  END IF;

  SELECT COALESCE(array_agg(ledger.id ORDER BY ledger.id), ARRAY[]::text[])
  INTO target_ids
  FROM public.customer_debt_transactions ledger
  WHERE ledger.order_id = sale.id
    AND ledger.transaction_type = 'order_amend'
    AND ledger.id = ANY(ARRAY[
      'DTX-' || amendment.id,
      'DTX-OAM-OUT-' || amendment.order_id || '-' || revision_suffix,
      'DTX-OAM-IN-' || amendment.order_id || '-' || revision_suffix
    ]);
  IF NOT (p_ledger_id = ANY(target_ids)) THEN
    RAISE EXCEPTION 'Không tìm thấy bút toán công nợ của lần sửa cuối cùng';
  END IF;

  manual_pricing := amendment.old_data->>'pricing_version' = 'manual-v1';
  SELECT EXISTS (
    SELECT 1 FROM public.pricelists price_list
    WHERE price_list.id = amendment.old_data->>'pricelist_id'
      AND price_list.customer_id IS NULL
      AND price_list.customer_group_id IS NULL
      AND COALESCE(price_list.price_list_type, price_list.type, 'general') = 'general'
  ) INTO use_global_override;

  restore_input := jsonb_build_object(
    'idempotencyKey', gen_random_uuid()::text,
    'customerId', amendment.old_data->'customer_id',
    'customerName', amendment.old_data->'customer_name',
    'notes', amendment.old_data->'notes',
    'items', amendment.old_data->'items',
    'date', amendment.old_data->'order_date',
    'discountType', amendment.old_data->'discount_type',
    'discountValue', amendment.old_data->'discount_value',
    'otherFeeType', amendment.old_data->'other_fee_type',
    'otherFeeValue', amendment.old_data->'other_fee_value',
    'shippingFeeValue', amendment.old_data->'shipping_fee_value',
    'shippingFeeAmount', amendment.old_data->'shipping_fee_amount',
    'pricelistId', amendment.old_data->'pricelist_id',
    'manualPriceConfirmed', manual_pricing,
    'priceListOverride', use_global_override,
    'paidAmount', 0
  );
  rpc_result := public.rpc_amend_order(
    sale.id,
    restore_input,
    'Hoàn tác ' || amendment.id || ': ' || restore_reason
  );
  IF COALESCE((rpc_result->>'success')::boolean, false) IS NOT TRUE
     OR NULLIF(rpc_result->>'amendment_id', '') IS NULL THEN
    RAISE EXCEPTION 'Không thể hoàn tác lần sửa hóa đơn';
  END IF;
  reversal_amendment_id := rpc_result->>'amendment_id';

  SELECT * INTO STRICT restored
  FROM public.orders order_row
  WHERE order_row.id = sale.id;

  -- Price lists, SKU status or source data may have changed since the old
  -- snapshot was saved. Roll the entire operation back unless it restores the
  -- prior financial and line-item values exactly.
  IF restored.customer_id IS DISTINCT FROM NULLIF(amendment.old_data->>'customer_id', '')
     OR restored.customer_name IS DISTINCT FROM amendment.old_data->>'customer_name'
     OR restored.notes IS DISTINCT FROM amendment.old_data->>'notes'
     OR restored.pricelist_id IS DISTINCT FROM NULLIF(amendment.old_data->>'pricelist_id', '')
     OR restored.pricing_version IS DISTINCT FROM amendment.old_data->>'pricing_version'
     OR restored.order_date IS DISTINCT FROM NULLIF(amendment.old_data->>'order_date', '')::timestamptz
     OR public.p98_order_item_financial_signature(restored.items)
        IS DISTINCT FROM public.p98_order_item_financial_signature(amendment.old_data->'items')
     OR round(COALESCE(restored.total_market, 0)) IS DISTINCT FROM round(NULLIF(amendment.old_data->>'total_market', '')::numeric)
     OR round(COALESCE(restored.total_discount, 0)) IS DISTINCT FROM round(NULLIF(amendment.old_data->>'total_discount', '')::numeric)
     OR round(COALESCE(restored.subtotal, 0)) IS DISTINCT FROM round(NULLIF(amendment.old_data->>'subtotal', '')::numeric)
     OR restored.discount_type IS DISTINCT FROM amendment.old_data->>'discount_type'
     OR round(COALESCE(restored.discount_value, 0)) IS DISTINCT FROM round(NULLIF(amendment.old_data->>'discount_value', '')::numeric)
     OR round(COALESCE(restored.discount_amount, 0)) IS DISTINCT FROM round(NULLIF(amendment.old_data->>'discount_amount', '')::numeric)
     OR restored.other_fee_type IS DISTINCT FROM amendment.old_data->>'other_fee_type'
     OR round(COALESCE(restored.other_fee_value, 0)) IS DISTINCT FROM round(NULLIF(amendment.old_data->>'other_fee_value', '')::numeric)
     OR round(COALESCE(restored.other_fee_amount, 0)) IS DISTINCT FROM round(NULLIF(amendment.old_data->>'other_fee_amount', '')::numeric)
     OR round(COALESCE(restored.shipping_fee_amount, 0)) IS DISTINCT FROM round(NULLIF(amendment.old_data->>'shipping_fee_amount', '')::numeric)
     OR round(COALESCE(restored.total_payable, 0)) IS DISTINCT FROM round(NULLIF(amendment.old_data->>'total_payable', '')::numeric)
     OR round(COALESCE(restored.total_amount, 0)) IS DISTINCT FROM round(NULLIF(amendment.old_data->>'total_amount', '')::numeric)
     OR round(COALESCE(restored.debt_amount, 0)) IS DISTINCT FROM round(NULLIF(amendment.old_data->>'debt_amount', '')::numeric) THEN
    RAISE EXCEPTION 'Giá hoặc dữ liệu SKU đã đổi từ lần sửa trước; hệ thống đã giữ nguyên hóa đơn và công nợ';
  END IF;

  UPDATE public.order_amendments history
  SET reversed_by_amendment_id = reversal_amendment_id,
      reversal_reason = restore_reason,
      reversed_at = now(),
      reversed_by = actor.auth_user_id::text
  WHERE history.id = amendment.id;
  UPDATE public.order_amendments history
  SET reverses_amendment_id = amendment.id
  WHERE history.id = reversal_amendment_id;

  revision_suffix := right(reversal_amendment_id, 4);
  SELECT COALESCE(array_agg(ledger.id ORDER BY ledger.id), ARRAY[]::text[])
  INTO reversal_ids
  FROM public.customer_debt_transactions ledger
  WHERE ledger.order_id = sale.id
    AND ledger.transaction_type = 'order_amend'
    AND ledger.id = ANY(ARRAY[
      'DTX-' || reversal_amendment_id,
      'DTX-OAM-OUT-' || sale.id || '-' || revision_suffix,
      'DTX-OAM-IN-' || sale.id || '-' || revision_suffix
    ]);
  IF cardinality(reversal_ids) = 0 THEN
    RAISE EXCEPTION 'Không tìm thấy bút toán bù sau khi khôi phục hóa đơn';
  END IF;
  all_ledger_ids := target_ids || reversal_ids;

  INSERT INTO public.customer_debt_amendment_voids(
    ledger_id, customer_id, target_amendment_id, reversal_amendment_id,
    reason, performed_by, created_at
  )
  SELECT ledger.id, ledger.customer_id, amendment.id, reversal_amendment_id,
    restore_reason, actor.auth_user_id::text, now()
  FROM public.customer_debt_transactions ledger
  WHERE ledger.id = ANY(all_ledger_ids)
  ON CONFLICT (ledger_id) DO NOTHING;

  SELECT COALESCE(array_agg(DISTINCT ledger.customer_id ORDER BY ledger.customer_id), ARRAY[]::text[])
  INTO affected_customer_ids
  FROM public.customer_debt_transactions ledger
  WHERE ledger.id = ANY(all_ledger_ids);

  INSERT INTO public.audit_logs(
    table_name, action, record_id, old_data, new_data, performed_by, created_at
  ) VALUES (
    'orders', 'REVERT_AMENDMENT', sale.id, amendment.new_data,
    to_jsonb(restored) || jsonb_build_object(
      'reverted_amendment_id', amendment.id,
      'reversal_amendment_id', reversal_amendment_id,
      'voided_ledger_ids', to_jsonb(all_ledger_ids),
      'reason', restore_reason
    ), actor.auth_user_id::text, now()
  );

  RETURN jsonb_build_object(
    'success', true,
    'order_id', sale.id,
    'reverted_amendment_id', amendment.id,
    'reversal_amendment_id', reversal_amendment_id,
    'affected_customer_ids', to_jsonb(affected_customer_ids),
    'restored_total_payable', restored.total_payable
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_revertible_order_amendments(text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_revertible_order_amendments(text)
  TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_revert_order_amendment(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_revert_order_amendment(text, text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0098', 'Allow audited reversal of the latest eligible customer order amendment')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;
