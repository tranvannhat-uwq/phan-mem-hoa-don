BEGIN;

-- A finalized-order edit is a new accounting event, not a new sale. Keep the
-- original order/document identity and business time, recalculate prices on
-- the server, and append only the financial/commission delta.
CREATE TABLE IF NOT EXISTS public.order_amendments (
  id text PRIMARY KEY,
  order_id text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  reason text NOT NULL,
  old_data jsonb NOT NULL,
  new_data jsonb NOT NULL,
  performed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_amendments_order_created_idx
  ON public.order_amendments(order_id, created_at DESC);

ALTER TABLE public.order_amendments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.order_amendments FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpc_amend_order(
  p_order_id text,
  p_order jsonb,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_variable
DECLARE
  actor public.profiles%ROWTYPE;
  original_order public.orders%ROWTYPE;
  amended_order public.orders%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  old_customer public.customers%ROWTYPE;
  current_debt_entry public.customer_debt_transactions%ROWTYPE;
  product_row public.products%ROWTYPE;
  commission_group record;
  resolved_price record;
  item jsonb;
  canonical_item jsonb;
  canonical_items jsonb := '[]'::jsonb;
  selected_list_id text;
  customer_id text;
  customer_name text;
  amendment_key text := NULLIF(btrim(p_order->>'idempotencyKey'), '');
  existing_order_id text;
  amendment_id text;
  amendment_revision integer;
  item_index integer := 0;
  commission_index integer := 0;
  new_item_id text;
  manual_pricing boolean := false;
  color_markup_percent numeric;
  quantity numeric;
  unit_price numeric;
  gross_line numeric;
  line_discount_type text;
  line_discount_value numeric;
  line_discount numeric;
  line_total numeric;
  total_market numeric := 0;
  subtotal numeric := 0;
  line_discounts numeric := 0;
  order_discount_type text;
  order_discount_value numeric;
  order_discount numeric;
  other_fee_type text;
  other_fee_value numeric;
  other_fee numeric;
  shipping_fee numeric;
  total_payable numeric;
  total_amount numeric;
  debt_amount numeric;
  debt_delta numeric;
  old_balance numeric;
  new_balance numeric;
  old_customer_id text;
  amendment_changes jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: only Admin or Accounting may amend a finalized order'
      USING ERRCODE = '42501';
  END IF;
  IF NULLIF(btrim(p_order_id), '') IS NULL THEN
    RAISE EXCEPTION 'Original order id is required';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'An amendment reason of at least 3 characters is required';
  END IF;
  IF amendment_key IS NULL OR amendment_key !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION 'A valid amendment idempotency key UUID is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('order-amend:' || p_order_id, 0));

  SELECT history.order_id INTO existing_order_id
  FROM public.order_amendments history
  WHERE history.idempotency_key = amendment_key;
  IF existing_order_id IS NOT NULL THEN
    IF existing_order_id <> p_order_id THEN
      RAISE EXCEPTION '409: amendment idempotency key was already used for another order'
        USING ERRCODE = '23505';
    END IF;
    RETURN public.p1_order_response(p_order_id) || jsonb_build_object(
      'success', true,
      'already_amended', true,
      'original_order_id', p_order_id,
      'replacement_order_id', p_order_id,
      'amended_in_place', true
    );
  END IF;

  SELECT * INTO STRICT original_order
  FROM public.orders sale
  WHERE sale.id = p_order_id
  FOR UPDATE;
  IF original_order.status <> 'settled' THEN
    RAISE EXCEPTION 'Only a settled order without returns may be amended';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sales_returns sale_return
    WHERE COALESCE(sale_return.sale_id, sale_return.order_id) = original_order.id
      AND sale_return.status NOT IN ('cancelled', 'canceled', 'draft')
  ) THEN
    RAISE EXCEPTION 'Order has active sales returns and cannot be amended';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.payments payment
    WHERE payment.order_id = original_order.id AND payment.status = 'completed'
  ) THEN
    RAISE EXCEPTION 'Cancel linked order payments before amending the order';
  END IF;

  IF jsonb_typeof(p_order->'items') <> 'array'
     OR jsonb_array_length(p_order->'items') = 0 THEN
    RAISE EXCEPTION 'At least one order item is required';
  END IF;
  IF COALESCE((p_order->>'paidAmount')::numeric, 0) <> 0 THEN
    RAISE EXCEPTION 'Payments must be recorded by the payment transaction';
  END IF;

  old_customer_id := original_order.customer_id;
  customer_id := NULLIF(p_order->>'customerId', '');

  -- Lock both possible customer rows in a stable order. This keeps the whole
  -- invoice, debt and aggregate update atomic even when the customer changes.
  PERFORM 1
  FROM public.customers customer
  WHERE customer.id IN (old_customer_id, customer_id)
  ORDER BY customer.id
  FOR UPDATE;

  IF old_customer_id IS NOT NULL THEN
    SELECT * INTO STRICT old_customer
    FROM public.customers customer
    WHERE customer.id = old_customer_id;
    IF COALESCE(old_customer.total_transaction, 0) < COALESCE(original_order.total_payable, 0)
       OR COALESCE(old_customer.net_revenue, 0) < COALESCE(original_order.total_payable, 0) THEN
      RAISE EXCEPTION 'Customer revenue aggregates are inconsistent; amendment stopped for review';
    END IF;
  END IF;

  IF customer_id IS NOT NULL THEN
    SELECT * INTO STRICT customer_row
    FROM public.customers customer
    WHERE customer.id = customer_id
      AND COALESCE(customer.status, 'active') = 'active'
      AND customer.deleted_at IS NULL;
    customer_name := customer_row.name;
  ELSE
    customer_name := NULLIF(btrim(p_order->>'customerName'), '');
    IF customer_name IS NULL THEN RAISE EXCEPTION 'Customer is required'; END IF;
  END IF;

  manual_pricing := NULLIF(p_order->>'pricelistId', '') = 'retail'
    AND COALESCE(NULLIF(p_order->>'manualPriceConfirmed', '')::boolean, false);
  IF manual_pricing THEN
    selected_list_id := 'retail';
  ELSE
    selected_list_id := public.p25_resolve_order_price_list(
      customer_id,
      NULLIF(p_order->>'pricelistId', ''),
      COALESCE(NULLIF(p_order->>'priceListOverride', '')::boolean, false)
    );
  END IF;

  -- Rebuild the canonical item snapshot with the same authoritative product,
  -- price-list, color surcharge and discount rules used when creating an order.
  FOR item IN SELECT value FROM jsonb_array_elements(p_order->'items') LOOP
    item_index := item_index + 1;
    IF NOT manual_pricing
       AND NULLIF(item->>'priceListId', '') IS NOT NULL
       AND NOT public.can_use_price_list_for_customer(customer_id, item->>'priceListId') THEN
      RAISE EXCEPTION '403: item price list is not available for this customer'
        USING ERRCODE = '42501';
    END IF;

    SELECT * INTO STRICT product_row
    FROM public.products product
    WHERE product.id = COALESCE(NULLIF(item->>'variantId', ''), NULLIF(item->>'productId', ''))
      AND product.is_active = true;

    quantity := (item->>'quantity')::numeric;
    IF quantity IS NULL OR quantity <= 0 THEN
      RAISE EXCEPTION 'SKU % quantity must be positive', product_row.id;
    END IF;

    color_markup_percent := CASE
      WHEN right(btrim(COALESCE(item->>'colorCode', '')), 1) = '.' THEN 5
      WHEN upper(right(btrim(COALESCE(item->>'colorCode', '')), 1)) = 'T' THEN 15
      WHEN upper(right(btrim(COALESCE(item->>'colorCode', '')), 1)) = 'D' THEN 20
      WHEN upper(right(btrim(COALESCE(item->>'colorCode', '')), 1)) = 'A' THEN 25
      ELSE 0
    END;

    IF manual_pricing THEN
      SELECT NULL::numeric AS price, NULL::text AS source_list_id,
             NULL::text AS source_list_name, NULL::text AS source_type
      INTO resolved_price;
      unit_price := round(COALESCE(
        NULLIF(item->>'price', '')::numeric,
        NULLIF(item->>'unitPrice', '')::numeric
      ));
      IF unit_price IS NULL OR unit_price < 0 THEN
        RAISE EXCEPTION 'Manual price for SKU % must be a non-negative number', product_row.id;
      END IF;
    ELSE
      SELECT * INTO STRICT resolved_price
      FROM public.p40_resolve_sku_price_for_customer(
        selected_list_id, product_row.id, customer_id
      );
      unit_price := round(resolved_price.price * (1 + color_markup_percent / 100));
    END IF;

    gross_line := round(quantity * unit_price);
    line_discount_type := COALESCE(NULLIF(item->>'discountType', ''), 'percent');
    line_discount_value := COALESCE(
      NULLIF(item->>'discountValue', '')::numeric,
      NULLIF(item->>'discountPercent', '')::numeric,
      0
    );
    IF line_discount_value < 0 OR line_discount_type NOT IN ('percent', 'amount') THEN
      RAISE EXCEPTION 'Invalid line discount for SKU %', product_row.id;
    END IF;
    IF line_discount_type = 'percent' THEN
      IF line_discount_value > 100 THEN
        RAISE EXCEPTION 'Line discount cannot exceed 100 percent';
      END IF;
      line_discount := round(gross_line * line_discount_value / 100);
    ELSE
      line_discount := round(line_discount_value);
    END IF;
    IF line_discount > gross_line THEN RAISE EXCEPTION 'Line discount exceeds line value'; END IF;
    line_total := gross_line - line_discount;
    new_item_id := original_order.id || '-item-r' ||
      lpad((COALESCE((SELECT count(*) FROM public.order_amendments h WHERE h.order_id = original_order.id), 0) + 1)::text, 3, '0') ||
      '-' || lpad(item_index::text, 3, '0');

    canonical_item := jsonb_build_object(
      'id', new_item_id,
      'productId', product_row.id,
      'productGroupId', product_row.product_group_id,
      'variantId', product_row.id,
      'variantCode', COALESCE(product_row.variant_code, product_row.code),
      'baseCode', COALESCE(product_row.base_code, product_row.code),
      'productCode', COALESCE(product_row.variant_code, product_row.code),
      'productName', product_row.name,
      'brand', product_row.brand,
      'brandId', product_row.brand_id,
      'package', COALESCE(product_row.packaging_name, product_row.package_type, ''),
      'packagingName', COALESCE(product_row.packaging_name, product_row.package_type, ''),
      'weightOrVolume', COALESCE(product_row.weight_or_volume, product_row.package_weight),
      'unitName', COALESCE(product_row.unit_name, product_row.package_weight_unit, ''),
      'specificationSnapshot', COALESCE(product_row.display_specification, ''),
      'colorCode', COALESCE(item->>'colorCode', ''),
      'colorPercent', color_markup_percent,
      'quantity', quantity,
      'discountType', line_discount_type,
      'discountValue', line_discount_value,
      'discountPercent', CASE WHEN line_discount_type = 'percent' THEN line_discount_value ELSE 0 END,
      'discountAmount', line_discount,
      'price', unit_price,
      'unitPrice', unit_price,
      'listPrice', unit_price,
      'finalUnitPrice', round(line_total / quantity),
      'priceListId', CASE WHEN manual_pricing THEN NULL ELSE resolved_price.source_list_id END,
      'priceListNameSnapshot', CASE WHEN manual_pricing THEN 'Nhập tay có xác nhận' ELSE resolved_price.source_list_name END,
      'priceSource', CASE WHEN manual_pricing THEN 'manual_override' ELSE resolved_price.source_type END,
      'lineTotal', line_total,
      'notes', COALESCE(item->>'notes', '')
    );
    canonical_items := canonical_items || jsonb_build_array(canonical_item);
    total_market := total_market + gross_line;
    subtotal := subtotal + line_total;
    line_discounts := line_discounts + line_discount;
  END LOOP;

  order_discount_type := COALESCE(NULLIF(p_order->>'discountType', ''), 'amount');
  order_discount_value := COALESCE(NULLIF(p_order->>'discountValue', '')::numeric, 0);
  IF order_discount_value < 0 OR order_discount_type NOT IN ('percent', 'amount') THEN
    RAISE EXCEPTION 'Invalid order discount';
  END IF;
  IF order_discount_type = 'percent' THEN
    IF order_discount_value > 100 THEN RAISE EXCEPTION 'Order discount cannot exceed 100 percent'; END IF;
    order_discount := round(subtotal * order_discount_value / 100);
  ELSE
    order_discount := round(order_discount_value);
  END IF;
  IF order_discount > subtotal THEN RAISE EXCEPTION 'Order discount exceeds subtotal'; END IF;

  other_fee_type := COALESCE(NULLIF(p_order->>'otherFeeType', ''), 'amount');
  other_fee_value := COALESCE(NULLIF(p_order->>'otherFeeValue', '')::numeric, 0);
  IF other_fee_value < 0 OR other_fee_type NOT IN ('percent', 'amount') THEN
    RAISE EXCEPTION 'Invalid other fee';
  END IF;
  IF other_fee_type = 'percent' THEN
    other_fee := round((subtotal - order_discount) * other_fee_value / 100);
  ELSE
    other_fee := round(other_fee_value);
  END IF;
  shipping_fee := round(COALESCE(
    NULLIF(p_order->>'shippingFeeValue', '')::numeric,
    NULLIF(p_order->>'shippingFeeAmount', '')::numeric,
    0
  ));
  IF shipping_fee < 0 THEN RAISE EXCEPTION 'Shipping fee cannot be negative'; END IF;

  total_payable := subtotal - order_discount + other_fee;
  total_amount := total_payable + shipping_fee;
  debt_amount := total_amount;
  debt_delta := debt_amount - COALESCE(original_order.debt_amount, 0);
  amendment_revision := COALESCE((
    SELECT count(*) FROM public.order_amendments history
    WHERE history.order_id = original_order.id
  ), 0) + 1;
  amendment_id := 'OAM-' || original_order.id || '-' || lpad(amendment_revision::text, 4, '0');

  -- Neutralize the commission currently attributable to this order. New item
  -- inserts below recreate it using the original order date/salesperson, so a
  -- September edit of an August invoice stays in the August salary period.
  FOR commission_group IN
    SELECT tx.employee_id, tx.salary_period, tx.calculation_basis, tx.rule_id,
      max(tx.commission_rate) AS commission_rate,
      sum(COALESCE(tx.basis_amount, 0)) AS basis_amount,
      sum(COALESCE(tx.commission_amount, 0)) AS commission_amount
    FROM public.commission_transactions tx
    WHERE tx.order_id = original_order.id
      AND tx.status NOT IN ('cancelled', 'canceled')
    GROUP BY tx.employee_id, tx.salary_period, tx.calculation_basis, tx.rule_id
    HAVING sum(COALESCE(tx.basis_amount, 0)) <> 0
        OR sum(COALESCE(tx.commission_amount, 0)) <> 0
  LOOP
    commission_index := commission_index + 1;
    INSERT INTO public.commission_transactions(
      id, employee_id, salary_period, order_id, transaction_type,
      calculation_basis, basis_amount, commission_rate, commission_amount,
      rule_id, status, calculated_at, created_at, created_by
    ) VALUES (
      'COMM-OAM-REV-' || original_order.id || '-' || lpad(amendment_revision::text, 4, '0') || '-' || commission_index,
      commission_group.employee_id, commission_group.salary_period, original_order.id,
      'order_amend_reversal', commission_group.calculation_basis,
      -commission_group.basis_amount, commission_group.commission_rate,
      -commission_group.commission_amount, commission_group.rule_id,
      'pending', now(), now(), actor.auth_user_id::text
    );
  END LOOP;

  DELETE FROM public.order_items item_row WHERE item_row.order_id = original_order.id;

  UPDATE public.orders sale
  SET customer_id = customer_id,
      customer_name = customer_name,
      notes = COALESCE(p_order->>'notes', ''),
      items = canonical_items,
      total_market = total_market,
      total_discount = line_discounts + order_discount,
      subtotal = subtotal,
      discount_value = order_discount_value,
      discount_type = order_discount_type,
      discount_amount = order_discount,
      other_fee_value = other_fee_value,
      other_fee_type = other_fee_type,
      other_fee_amount = other_fee,
      shipping_fee_value = shipping_fee,
      shipping_fee_amount = shipping_fee,
      total_payable = total_payable,
      total_amount = total_amount,
      paid_amount = 0,
      debt_amount = debt_amount,
      returned_amount = 0,
      net_revenue = total_payable,
      pricelist_id = selected_list_id,
      customer_manager_id = CASE WHEN customer_id IS NULL THEN NULL ELSE customer_row.managed_by END,
      pricing_version = CASE WHEN manual_pricing THEN 'manual-v1' ELSE 'p1-v1' END,
      status = 'settled',
      updated_at = now(),
      updated_by = actor.auth_user_id::text
  WHERE sale.id = original_order.id;

  FOR canonical_item IN SELECT value FROM jsonb_array_elements(canonical_items) LOOP
    INSERT INTO public.order_items(
      id, order_id, product_id, product_group_id, variant_id, brand_id,
      product_code_snapshot, variant_code_snapshot, product_name_snapshot,
      packaging_name_snapshot, weight_or_volume_snapshot, specification_snapshot,
      unit_snapshot, price_list_id, price_list_name_snapshot, price_source,
      price_selected_by, quantity, list_price, unit_price, sale_price,
      final_unit_price, discount_percent, discount_amount, line_total,
      net_amount, created_at
    ) VALUES (
      canonical_item->>'id', original_order.id, canonical_item->>'productId',
      NULLIF(canonical_item->>'productGroupId', ''), canonical_item->>'variantId',
      NULLIF(canonical_item->>'brandId', ''), canonical_item->>'productCode',
      canonical_item->>'variantCode', canonical_item->>'productName',
      canonical_item->>'packagingName',
      concat_ws(' ', canonical_item->>'weightOrVolume', canonical_item->>'unitName'),
      canonical_item->>'specificationSnapshot', canonical_item->>'unitName',
      NULLIF(canonical_item->>'priceListId', ''), canonical_item->>'priceListNameSnapshot',
      canonical_item->>'priceSource', actor.auth_user_id::text,
      (canonical_item->>'quantity')::numeric, (canonical_item->>'listPrice')::numeric,
      (canonical_item->>'unitPrice')::numeric, (canonical_item->>'finalUnitPrice')::numeric,
      (canonical_item->>'finalUnitPrice')::numeric,
      (canonical_item->>'discountPercent')::numeric,
      (canonical_item->>'discountAmount')::numeric,
      (canonical_item->>'lineTotal')::numeric,
      (canonical_item->>'lineTotal')::numeric,
      original_order.order_date
    );
  END LOOP;

  -- Fold the delta into the original debt document. created_at remains the
  -- posting/audit time; transaction_date remains the original invoice time.
  IF old_customer_id IS NOT DISTINCT FROM customer_id THEN
    IF customer_id IS NOT NULL THEN
      old_balance := round(COALESCE(old_customer.debt, 0));
      new_balance := old_balance + round(debt_delta);
      UPDATE public.customers customer
      SET debt = new_balance,
          total_transaction = COALESCE(old_customer.total_transaction, 0)
            - COALESCE(original_order.total_payable, 0) + total_payable,
          net_revenue = COALESCE(old_customer.net_revenue, 0)
            - COALESCE(original_order.total_payable, 0) + total_payable,
          last_order_at = GREATEST(COALESCE(old_customer.last_order_at, original_order.order_date), original_order.order_date),
          updated_at = now(), updated_by = actor.auth_user_id::text
      WHERE customer.id = customer_id;

      IF round(debt_delta) <> 0 THEN
        SELECT * INTO current_debt_entry
        FROM public.customer_debt_transactions ledger
        WHERE ledger.order_id = original_order.id
          AND ledger.customer_id = customer_id
          AND ledger.transaction_type IN ('order', 'order_amend')
        ORDER BY ledger.created_at DESC, ledger.id DESC
        LIMIT 1;
        INSERT INTO public.customer_debt_transactions(
          id, customer_id, transaction_type, amount, debt_change,
          balance_before, balance_after, order_id, amends_ledger_id,
          description, created_by, transaction_date
        ) VALUES (
          'DTX-OAM-' || original_order.id || '-' || lpad(amendment_revision::text, 4, '0'),
          customer_id, 'order_amend', abs(round(debt_delta)), round(debt_delta),
          old_balance, new_balance, original_order.id, current_debt_entry.id,
          'Sửa đơn ' || original_order.id || ': ' || btrim(p_reason),
          actor.auth_user_id::text, original_order.order_date
        );
      END IF;
    END IF;
  ELSE
    IF old_customer_id IS NOT NULL THEN
      old_balance := round(COALESCE(old_customer.debt, 0));
      new_balance := old_balance - round(COALESCE(original_order.debt_amount, 0));
      SELECT * INTO current_debt_entry
      FROM public.customer_debt_transactions ledger
      WHERE ledger.order_id = original_order.id
        AND ledger.customer_id = old_customer_id
        AND ledger.transaction_type IN ('order', 'order_amend')
      ORDER BY ledger.created_at DESC, ledger.id DESC
      LIMIT 1;
      UPDATE public.customers customer
      SET debt = new_balance,
          total_transaction = COALESCE(old_customer.total_transaction, 0) - COALESCE(original_order.total_payable, 0),
          net_revenue = COALESCE(old_customer.net_revenue, 0) - COALESCE(original_order.total_payable, 0),
          updated_at = now(), updated_by = actor.auth_user_id::text
      WHERE customer.id = old_customer_id;
      IF round(COALESCE(original_order.debt_amount, 0)) <> 0 THEN
        INSERT INTO public.customer_debt_transactions(
          id, customer_id, transaction_type, amount, debt_change,
          balance_before, balance_after, order_id, amends_ledger_id,
          description, created_by, transaction_date
        ) VALUES (
          'DTX-OAM-OUT-' || original_order.id || '-' || lpad(amendment_revision::text, 4, '0'),
          old_customer_id, 'order_amend', abs(round(original_order.debt_amount)),
          -round(original_order.debt_amount), old_balance, new_balance,
          original_order.id, current_debt_entry.id,
          'Chuyển đơn ' || original_order.id || ' sang khách hàng khác: ' || btrim(p_reason),
          actor.auth_user_id::text, original_order.order_date
        );
      END IF;
    END IF;

    IF customer_id IS NOT NULL THEN
      old_balance := round(COALESCE(customer_row.debt, 0));
      new_balance := old_balance + round(debt_amount);
      UPDATE public.customers customer
      SET debt = new_balance,
          total_transaction = COALESCE(customer_row.total_transaction, 0) + total_payable,
          net_revenue = COALESCE(customer_row.net_revenue, 0) + total_payable,
          last_order_at = GREATEST(COALESCE(customer_row.last_order_at, original_order.order_date), original_order.order_date),
          updated_at = now(), updated_by = actor.auth_user_id::text
      WHERE customer.id = customer_id;
      IF round(debt_amount) <> 0 THEN
        INSERT INTO public.customer_debt_transactions(
          id, customer_id, transaction_type, amount, debt_change,
          balance_before, balance_after, order_id, amends_ledger_id,
          description, created_by, transaction_date
        ) VALUES (
          'DTX-OAM-IN-' || original_order.id || '-' || lpad(amendment_revision::text, 4, '0'),
          customer_id, 'order_amend', abs(round(debt_amount)), round(debt_amount),
          old_balance, new_balance, original_order.id, current_debt_entry.id,
          'Nhận đơn chuyển ' || original_order.id || ': ' || btrim(p_reason),
          actor.auth_user_id::text, original_order.order_date
        );
      END IF;
    END IF;
  END IF;

  SELECT * INTO STRICT amended_order
  FROM public.orders sale WHERE sale.id = original_order.id;
  IF amended_order.order_date IS DISTINCT FROM original_order.order_date
     OR amended_order.created_at IS DISTINCT FROM original_order.created_at
     OR amended_order.created_by IS DISTINCT FROM original_order.created_by
     OR amended_order.salesperson_id IS DISTINCT FROM original_order.salesperson_id THEN
    RAISE EXCEPTION 'Original order identity, time or salesperson was not preserved';
  END IF;

  INSERT INTO public.order_amendments(
    id, order_id, idempotency_key, reason, old_data, new_data,
    performed_by, created_at
  ) VALUES (
    amendment_id, original_order.id, amendment_key, btrim(p_reason),
    to_jsonb(original_order), to_jsonb(amended_order),
    actor.auth_user_id::text, now()
  );

  INSERT INTO public.audit_logs(
    table_name, action, record_id, old_data, new_data, performed_by, created_at
  ) VALUES (
    'orders', 'AMEND_IN_PLACE', original_order.id, to_jsonb(original_order),
    to_jsonb(amended_order) || jsonb_build_object(
      'amendment_id', amendment_id,
      'idempotency_key', amendment_key,
      'reason', btrim(p_reason),
      'debt_delta', debt_delta,
      'financial_strategy', 'in_place_delta'
    ),
    actor.auth_user_id::text, now()
  );

  amendment_changes := public.p36_activity_changes(
    to_jsonb(original_order), to_jsonb(amended_order)
  ) || jsonb_build_object(
    'reason', jsonb_build_object('old', NULL, 'new', to_jsonb(btrim(p_reason)))
  );
  UPDATE public.activity_logs
  SET action = 'update_order',
      description = 'update_order:' || original_order.id,
      changes = amendment_changes,
      metadata = metadata || jsonb_build_object(
        'operation', 'AMEND_IN_PLACE',
        'amendment_id', amendment_id,
        'debt_delta', debt_delta
      )
  WHERE operation_key = txid_current()::text
    AND module = 'orders'
    AND target_type = 'order'
    AND target_id = original_order.id;

  RETURN public.p1_order_response(original_order.id) || jsonb_build_object(
    'success', true,
    'already_amended', false,
    'original_order_id', original_order.id,
    'replacement_order_id', original_order.id,
    'amended_in_place', true,
    'amendment_id', amendment_id,
    'amendment_reason', btrim(p_reason),
    'debt_delta', debt_delta
  );
END;
$$;

ALTER FUNCTION public.rpc_amend_order(text, jsonb, text) SECURITY DEFINER;
ALTER FUNCTION public.rpc_amend_order(text, jsonb, text) SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.rpc_amend_order(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_amend_order(text, jsonb, text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0057', 'Amend finalized orders in place with debt and commission deltas')
ON CONFLICT(version) DO NOTHING;

COMMIT;
