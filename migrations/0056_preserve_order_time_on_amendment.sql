BEGIN;

-- An amendment is posted now, but it must keep the exact business timestamp
-- of the original order. The posting time belongs in audit/activity history,
-- never in orders.order_date.

-- Drafts use created_at as their order timestamp. Direct browser upserts must
-- not be able to replace it when a draft is edited.
CREATE OR REPLACE FUNCTION public.p56_preserve_draft_order_created_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p56_preserve_draft_order_created_at ON public.draft_orders;
CREATE TRIGGER p56_preserve_draft_order_created_at
BEFORE UPDATE OF created_at ON public.draft_orders
FOR EACH ROW EXECUTE FUNCTION public.p56_preserve_draft_order_created_at();

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
  replacement_order public.orders%ROWTYPE;
  replacement jsonb;
  replacement_id text;
  amendment_key text := NULLIF(btrim(p_order->>'idempotencyKey'), '');
  active_return_count integer;
  amendment_changes jsonb;
  activity_rows integer := 0;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: only Admin or Accounting may amend a finalized order'
      USING ERRCODE = '42501';
  END IF;
  IF p_order_id IS NULL OR btrim(p_order_id) = '' THEN
    RAISE EXCEPTION 'Original order id is required';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'An amendment reason of at least 3 characters is required';
  END IF;
  IF amendment_key IS NULL THEN
    RAISE EXCEPTION 'A stable amendment idempotency key is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('order-amend:' || p_order_id, 0));

  -- The replacement carries the stable amendment key. Read it directly from
  -- the business row because short audit retention may already have compacted
  -- or removed the corresponding audit payload.
  SELECT sale.id
  INTO replacement_id
  FROM public.orders sale
  WHERE sale.idempotency_key = amendment_key
    AND sale.created_by = actor.auth_user_id::text
  ORDER BY sale.created_at DESC
  LIMIT 1;
  IF replacement_id IS NOT NULL THEN
    RETURN public.p1_order_response(replacement_id) || jsonb_build_object(
      'already_amended', true,
      'original_order_id', p_order_id,
      'replacement_order_id', replacement_id
    );
  END IF;

  SELECT * INTO STRICT original_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF original_order.status <> 'settled' THEN
    RAISE EXCEPTION 'Only a settled order without returns may be amended';
  END IF;

  SELECT count(*) INTO active_return_count
  FROM public.sales_returns sale_return
  WHERE COALESCE(sale_return.sale_id, sale_return.order_id) = original_order.id
    AND sale_return.status NOT IN ('cancelled', 'canceled', 'draft');
  IF active_return_count > 0 THEN
    RAISE EXCEPTION 'Order has active sales returns and cannot be amended';
  END IF;

  PERFORM public.p19_reverse_order_for_amendment(
    original_order.id,
    'Sửa đơn đã chốt: ' || btrim(p_reason)
  );

  -- Never accept a reconstructed browser time for an amendment. Removing the
  -- submitted date before adding the authoritative timestamp also prevents a
  -- duplicate JSON key from changing this rule.
  replacement := public.rpc_confirm_order(
    (p_order - 'draftId' - 'date') || jsonb_build_object(
      'date', original_order.order_date,
      'amendedFromOrderId', original_order.id
    )
  );
  replacement_id := replacement->>'order_id';
  IF replacement_id IS NULL THEN
    RAISE EXCEPTION 'Replacement order was not returned by the confirmation transaction';
  END IF;

  SELECT * INTO STRICT replacement_order
  FROM public.orders
  WHERE id = replacement_id;

  IF replacement_order.order_date IS DISTINCT FROM original_order.order_date THEN
    RAISE EXCEPTION 'Amended order timestamp was not preserved';
  END IF;

  INSERT INTO public.audit_logs(
    table_name, action, record_id, old_data, new_data, performed_by, created_at
  ) VALUES (
    'orders', 'AMEND', original_order.id, to_jsonb(original_order),
    to_jsonb(replacement_order) || jsonb_build_object(
      'replacement_order_id', replacement_id,
      'idempotency_key', amendment_key,
      'reason', btrim(p_reason),
      'financial_strategy', 'cancel_original_and_confirm_replacement'
    ),
    actor.auth_user_id::text, now()
  );

  -- rpc_confirm_order already created one activity row for the replacement in
  -- this transaction. Reclassify that row as an edit and attach the meaningful
  -- before/after values, so the real edit time appears only in Activity.
  amendment_changes := public.p36_activity_changes(
    to_jsonb(original_order),
    to_jsonb(replacement_order)
  ) || jsonb_build_object(
    'reason', jsonb_build_object('old', NULL, 'new', to_jsonb(btrim(p_reason)))
  );

  UPDATE public.activity_logs
  SET action = 'update_order',
      description = 'update_order:' || replacement_id,
      changes = amendment_changes,
      metadata = metadata || jsonb_build_object(
        'operation', 'AMEND',
        'amended_from_order_id', original_order.id
      )
  WHERE operation_key = txid_current()::text
    AND module = 'orders'
    AND target_type = 'order'
    AND target_id = replacement_id;
  GET DIAGNOSTICS activity_rows = ROW_COUNT;

  IF activity_rows = 0 THEN
    INSERT INTO public.activity_logs(
      operation_key, actor_id, actor_profile_id, actor_username, actor_name,
      actor_role, action, module, target_type, target_id, target_name, order_id,
      customer_id, company_id, description, changes, metadata, created_at
    ) VALUES (
      txid_current()::text || ':amend', actor.auth_user_id, actor.id,
      actor.username, actor.display_name, actor.role, 'update_order', 'orders',
      'order', replacement_id, replacement_order.customer_name, replacement_id,
      replacement_order.customer_id, replacement_order.company_id,
      'update_order:' || replacement_id, amendment_changes,
      jsonb_build_object(
        'table', 'orders',
        'operation', 'AMEND',
        'amended_from_order_id', original_order.id
      ), now()
    );
  END IF;

  RETURN replacement || jsonb_build_object(
    'already_amended', false,
    'original_order_id', original_order.id,
    'replacement_order_id', replacement_id,
    'amendment_reason', btrim(p_reason)
  );
END;
$$;

ALTER FUNCTION public.rpc_amend_order(text, jsonb, text) SECURITY DEFINER;
ALTER FUNCTION public.rpc_amend_order(text, jsonb, text) SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.p56_preserve_draft_order_created_at() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_amend_order(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_amend_order(text, jsonb, text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0056', 'Preserve original order timestamp and record amendment activity')
ON CONFLICT(version) DO NOTHING;

COMMIT;
