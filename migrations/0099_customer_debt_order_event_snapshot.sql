BEGIN;

-- Return only the order snapshot belonging to the exact customer-debt event.
-- The current orders row can belong to a different customer after an in-place
-- amendment, so it must never be used as an unscoped fallback.
CREATE OR REPLACE FUNCTION public.rpc_get_customer_debt_order_event_snapshot(
  p_ledger_id text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  ledger public.customer_debt_transactions%ROWTYPE;
  snapshot jsonb;
  event_context text := 'order';
BEGIN
  actor := public.require_authenticated_profile();
  SELECT * INTO ledger
  FROM public.customer_debt_transactions tx
  WHERE tx.id = p_ledger_id AND tx.order_id IS NOT NULL;
  IF NOT FOUND OR NOT public.can_access_customer(ledger.customer_id) THEN
    RAISE EXCEPTION '404: customer debt source is unavailable'
      USING ERRCODE = '42501';
  END IF;

  IF ledger.id LIKE 'DTX-OAM-OUT-%' THEN
    SELECT amendment.old_data INTO snapshot
    FROM public.order_amendments amendment
    WHERE ledger.id = 'DTX-OAM-OUT-' || substring(amendment.id FROM 5)
      AND amendment.order_id = ledger.order_id
      AND amendment.old_data->>'customer_id' = ledger.customer_id
    ORDER BY amendment.created_at DESC, amendment.id DESC
    LIMIT 1;
    event_context := 'transfer_out';
  ELSIF ledger.id LIKE 'DTX-OAM-IN-%' THEN
    SELECT amendment.new_data INTO snapshot
    FROM public.order_amendments amendment
    WHERE ledger.id = 'DTX-OAM-IN-' || substring(amendment.id FROM 5)
      AND amendment.order_id = ledger.order_id
      AND amendment.new_data->>'customer_id' = ledger.customer_id
    ORDER BY amendment.created_at DESC, amendment.id DESC
    LIMIT 1;
    event_context := 'transfer_in';
  ELSIF ledger.id LIKE 'DTX-OAM-%' THEN
    SELECT amendment.new_data INTO snapshot
    FROM public.order_amendments amendment
    WHERE ledger.id = 'DTX-' || amendment.id
      AND amendment.order_id = ledger.order_id
      AND amendment.new_data->>'customer_id' = ledger.customer_id
    ORDER BY amendment.created_at DESC, amendment.id DESC
    LIMIT 1;
    event_context := 'amendment';
  ELSE
    -- Original debt event: if the order was amended, its first old_data is the
    -- original sale. Otherwise the current row is safe only for the same customer.
    SELECT amendment.old_data INTO snapshot
    FROM public.order_amendments amendment
    WHERE amendment.order_id = ledger.order_id
      AND amendment.old_data->>'customer_id' = ledger.customer_id
    ORDER BY amendment.created_at, amendment.id
    LIMIT 1;
    IF snapshot IS NULL THEN
      SELECT to_jsonb(sale) INTO snapshot
      FROM public.orders sale
      WHERE sale.id = ledger.order_id
        AND sale.customer_id = ledger.customer_id;
    END IF;
    event_context := 'original_order';
  END IF;

  IF snapshot IS NULL
     OR snapshot->>'id' IS DISTINCT FROM ledger.order_id
     OR snapshot->>'customer_id' IS DISTINCT FROM ledger.customer_id THEN
    RETURN jsonb_build_object(
      'available', false,
      'order_id', ledger.order_id,
      'customer_id', ledger.customer_id,
      'event_context', event_context
    );
  END IF;

  RETURN jsonb_build_object(
    'available', true,
    'order_id', ledger.order_id,
    'customer_id', ledger.customer_id,
    'event_context', event_context,
    'order', jsonb_build_object(
      'id', snapshot->>'id',
      'customer_id', snapshot->>'customer_id',
      'customer_name', snapshot->>'customer_name',
      'order_date', snapshot->>'order_date',
      'status', snapshot->>'status',
      'items', COALESCE(snapshot->'items', '[]'::jsonb),
      'subtotal', snapshot->'subtotal',
      'total_market', snapshot->'total_market',
      'discount_amount', snapshot->'discount_amount',
      'total_payable', snapshot->'total_payable',
      'notes', snapshot->>'notes'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_customer_debt_order_event_snapshot(text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_customer_debt_order_event_snapshot(text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0099', 'Return customer-scoped order snapshots for debt history events')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;
