-- Runtime fix for the current local-login architecture.
-- No table is dropped, truncated, reset, or rewritten by this migration.

DO $$
DECLARE
    table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'users', 'products', 'customers', 'pricelists', 'brands',
        'orders', 'draft_orders', 'order_items'
    ]
    LOOP
        IF to_regclass('public.' || table_name) IS NULL THEN
            CONTINUE;
        END IF;

        IF EXISTS (
            SELECT 1
            FROM pg_policies
            WHERE schemaname = 'public'
              AND tablename = table_name
              AND policyname = 'local_app_anon_access'
        ) THEN
            EXECUTE format(
                'ALTER POLICY local_app_anon_access ON public.%I TO anon USING (true) WITH CHECK (true)',
                table_name
            );
        ELSE
            EXECUTE format(
                'CREATE POLICY local_app_anon_access ON public.%I FOR ALL TO anon USING (true) WITH CHECK (true)',
                table_name
            );
        END IF;
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.rpc_confirm_order(p_order jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order_id text := NULLIF(p_order->>'id', '');
    v_customer_id text := NULLIF(p_order->>'customerId', '');
    v_total_payable numeric := COALESCE((p_order->>'totalPayable')::numeric, 0);
    v_paid_amount numeric := COALESCE((p_order->>'paidAmount')::numeric, 0);
    v_debt_amount numeric;
    v_debt_change numeric := 0;
    v_created_by text := COALESCE(NULLIF(p_order->>'createdBy', ''), 'admin');
    v_balance_before numeric := 0;
    v_balance_after numeric := 0;
    v_item jsonb;
    v_item_index integer := 0;
    v_product_code text;
    v_brand text;
    v_package text;
    v_quantity numeric;
    v_price numeric;
    v_discount_percent numeric;
    v_line_total numeric;
    v_cashbook_id text;
BEGIN
    IF v_order_id IS NULL THEN
        RAISE EXCEPTION 'Mã đơn hàng không được để trống';
    END IF;
    IF jsonb_typeof(p_order->'items') <> 'array'
       OR jsonb_array_length(p_order->'items') = 0 THEN
        RAISE EXCEPTION 'Đơn hàng phải có ít nhất một sản phẩm';
    END IF;
    IF v_total_payable < 0 OR v_paid_amount < 0 OR v_paid_amount > v_total_payable THEN
        RAISE EXCEPTION 'Số tiền đơn hàng hoặc thanh toán không hợp lệ';
    END IF;

    -- A repeated submit is a successful no-op and cannot change aggregates twice.
    IF EXISTS (
        SELECT 1 FROM public.orders
        WHERE id = v_order_id AND status <> 'draft'
    ) THEN
        DELETE FROM public.draft_orders WHERE id = v_order_id;
        RETURN jsonb_build_object('success', true, 'order_id', v_order_id, 'already_finalized', true);
    END IF;

    v_debt_amount := v_total_payable - v_paid_amount;

    -- 1. Save order.
    INSERT INTO public.orders (
        id, customer_id, customer_name, salesperson_id, customer_manager_id,
        company_id, revenue_brand_id, notes, items, total_market, total_discount,
        subtotal, discount_value, discount_type, discount_amount, other_fee_value,
        other_fee_type, other_fee_amount, total_payable, total_amount, paid_amount,
        debt_amount, returned_amount, net_revenue, status, order_date, confirmed_at,
        pricelist_id, created_by, created_at, updated_at
    ) VALUES (
        v_order_id, v_customer_id, COALESCE(p_order->>'customerName', ''),
        COALESCE(p_order->>'salespersonId', v_created_by), p_order->>'customerManagerId',
        COALESCE(p_order->>'companyId', 'ABS_NORTH'), p_order->>'revenueBrandId',
        COALESCE(p_order->>'notes', ''), p_order->'items',
        COALESCE((p_order->>'totalMarket')::numeric, 0),
        COALESCE((p_order->>'totalDiscount')::numeric, 0),
        COALESCE((p_order->>'subtotal')::numeric, v_total_payable),
        COALESCE((p_order->>'discountValue')::numeric, 0),
        COALESCE(p_order->>'discountType', 'amount'),
        COALESCE((p_order->>'discountAmount')::numeric, 0),
        COALESCE((p_order->>'otherFeeValue')::numeric, 0),
        COALESCE(p_order->>'otherFeeType', 'amount'),
        COALESCE((p_order->>'otherFeeAmount')::numeric, 0),
        v_total_payable, v_total_payable, v_paid_amount, v_debt_amount, 0,
        v_total_payable, 'settled',
        COALESCE((p_order->>'date')::timestamptz, now()), now(),
        COALESCE(p_order->>'pricelistId', 'retail'), v_created_by,
        COALESCE((p_order->>'date')::timestamptz, now()), now()
    );

    -- 2. Save every item. Any exception rolls back the order as well.
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_order->'items')
    LOOP
        v_product_code := COALESCE(v_item->>'productCode', v_item->>'code', '');
        v_brand := COALESCE(v_item->>'brand', '');
        v_package := COALESCE(v_item->>'package', v_item->>'packageType', '');
        v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
        v_price := COALESCE((v_item->>'price')::numeric, 0);
        v_discount_percent := COALESCE((v_item->>'discountPercent')::numeric, 0);
        v_line_total := round(v_quantity * v_price * (1 - v_discount_percent / 100));

        IF v_product_code = '' OR v_quantity <= 0 THEN
            RAISE EXCEPTION 'Dòng sản phẩm % không hợp lệ', v_item_index + 1;
        END IF;

        INSERT INTO public.order_items (
            id, order_id, product_id, brand_id, product_code_snapshot,
            product_name_snapshot, unit_snapshot, quantity, list_price,
            sale_price, discount_percent, discount_amount, line_total,
            returned_quantity, returned_amount, net_amount, created_at
        ) VALUES (
            COALESCE(NULLIF(v_item->>'id', ''), v_order_id || '-item-' || v_item_index),
            v_order_id, v_product_code, NULLIF(v_brand, ''), v_product_code,
            COALESCE(v_item->>'productName', v_item->>'name', ''),
            v_package, v_quantity, v_price, v_price, v_discount_percent,
            round(v_quantity * v_price) - v_line_total, v_line_total,
            0, 0, v_line_total, now()
        );

        -- 3. Stock changes only after order + items succeeded.
        UPDATE public.finished_goods_stock
        SET quantity = quantity - v_quantity, updated_at = now()
        WHERE product_code = v_product_code
          AND brand = v_brand
          AND lower(package_type) = lower(v_package);

        v_item_index := v_item_index + 1;
    END LOOP;

    -- 4. Revenue, debt and debt history.
    IF v_customer_id IS NOT NULL THEN
        SELECT COALESCE(debt, 0)
        INTO STRICT v_balance_before
        FROM public.customers
        WHERE id = v_customer_id
        FOR UPDATE;

        -- Existing imported receivables are negative. A new unpaid order must
        -- move the balance away from zero while preserving legacy positive
        -- balances if any still exist.
        v_debt_change := CASE
            WHEN v_balance_before <= 0 THEN -v_debt_amount
            ELSE v_debt_amount
        END;
        v_balance_after := v_balance_before + v_debt_change;

        INSERT INTO public.customer_debt_transactions (
            id, customer_id, transaction_type, amount, debt_change,
            balance_before, balance_after, order_id, description,
            created_by, transaction_date
        ) VALUES (
            'dtx-ord-' || v_order_id, v_customer_id, 'order',
            v_total_payable, v_debt_change, v_balance_before, v_balance_after,
            v_order_id, 'Mua hàng (Hóa đơn ' || v_order_id || ')',
            v_created_by, now()
        );

        UPDATE public.customers
        SET total_transaction = COALESCE(total_transaction, 0) + v_total_payable,
            net_revenue = COALESCE(net_revenue, 0) + v_total_payable,
            debt = v_balance_after,
            last_order_at = now(),
            updated_at = now()
        WHERE id = v_customer_id;
    END IF;

    -- 5. Cashbook changes only when the payload contains an actual payment.
    IF v_paid_amount > 0 THEN
        v_cashbook_id := 'cb-ord-' || v_order_id;
        INSERT INTO public.cashbook_transactions (
            id, date, type, category, partner, value, method,
            accounting, status, creator, note, customer_id, order_id
        ) VALUES (
            v_cashbook_id, now(), 'thu', 'Thu tiền bán hàng',
            COALESCE(p_order->>'customerName', 'Khách hàng'),
            v_paid_amount, COALESCE(p_order->>'paymentMethod', 'cash'),
            true, 'Đã thanh toán', v_created_by,
            'Thu tiền hàng cho hóa đơn ' || v_order_id,
            v_customer_id, v_order_id
        );
    END IF;

    DELETE FROM public.draft_orders WHERE id = v_order_id;

    RETURN jsonb_build_object(
        'success', true,
        'order_id', v_order_id,
        'new_debt', CASE WHEN v_customer_id IS NULL THEN NULL ELSE v_balance_after END,
        'debt_change', v_debt_change
    );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_confirm_order(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order(jsonb) TO anon, authenticated;
