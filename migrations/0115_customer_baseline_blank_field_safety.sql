BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

-- Preserve omitted customer financial baselines and latest dates on reimport
-- Only the function/ACL and migration registry are updated; no business row is rewritten.
DO $guard$
DECLARE body_hash text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version='0114') THEN
    RAISE EXCEPTION '0115: install retention/dealer support prerequisites through 0114 first';
  END IF;
  SELECT md5(replace(prosrc,chr(13),'')) INTO body_hash FROM pg_proc WHERE oid=to_regprocedure('public.rpc_import_customer_financial_baselines(jsonb)');
  IF body_hash IS NULL OR body_hash NOT IN ('bc12a073492326b1d117108a21221763','83c7207f81626291b059377db8d3d94a','516af2520e9df2335fb1774071cd3dce') THEN
    RAISE EXCEPTION '0115: unexpected function definition for public.rpc_import_customer_financial_baselines(jsonb); installation rolled back';
  END IF;
END $guard$;

CREATE OR REPLACE FUNCTION public.rpc_import_customer_financial_baselines(p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
#variable_conflict error
DECLARE
  v_actor public.profiles%ROWTYPE;
  v_item jsonb;
  v_customer_row public.customers%ROWTYPE;
  v_customer_id text;
  v_imported_debt numeric;
  v_imported_total numeric;
  v_imported_returns numeric;
  v_imported_net numeric;
  v_imported_last_order timestamptz;
  v_imported_created timestamptz;
  v_operational_last_order timestamptz;
  v_imported_at timestamptz;
  v_next_debt numeric;
  v_next_total numeric;
  v_next_returns numeric;
  v_next_net numeric;
  v_debt_delta numeric;
  v_ledger_id text;
  v_processed_count integer := 0;
BEGIN
  v_actor := public.require_authenticated_profile();
  IF v_actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Customer baseline payload must be a JSON array';
  END IF;
  IF jsonb_array_length(p_rows) < 1 OR jsonb_array_length(p_rows) > 250 THEN
    RAISE EXCEPTION 'Customer baseline payload must contain between 1 and 250 rows';
  END IF;

  FOR v_item IN SELECT payload.value FROM jsonb_array_elements(p_rows) AS payload(value)
  LOOP
    v_customer_id := NULLIF(btrim(v_item->>'id'), '');
    IF v_customer_id IS NULL THEN RAISE EXCEPTION 'Customer baseline row is missing id'; END IF;
    BEGIN
      v_imported_debt := round(NULLIF(v_item->>'debt', '')::numeric);
      v_imported_total := round(NULLIF(v_item->>'totalTransaction', '')::numeric);
      v_imported_returns := round(NULLIF(v_item->>'totalReturn', '')::numeric);
      v_imported_net := round(NULLIF(v_item->>'netRevenue', '')::numeric);
      v_imported_last_order := NULLIF(v_item->>'lastOrderAt', '')::timestamptz;
      v_imported_created := NULLIF(v_item->>'createdAt', '')::timestamptz;
      v_imported_at := COALESCE(NULLIF(v_item->>'importedAt', '')::timestamptz, now());
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Invalid financial baseline for customer %', v_customer_id;
    END;

    IF abs(v_imported_debt) > 1000000000000000
       OR abs(v_imported_total) > 1000000000000000
       OR abs(v_imported_returns) > 1000000000000000
       OR abs(v_imported_net) > 1000000000000000 THEN
      RAISE EXCEPTION 'Financial baseline is outside the allowed range for customer %', v_customer_id;
    END IF;

    SELECT customer_source.* INTO STRICT v_customer_row
    FROM public.customers customer_source
    WHERE customer_source.id = v_customer_id
    FOR UPDATE;

    v_imported_debt := COALESCE(v_imported_debt, v_customer_row.imported_debt_baseline, 0);
    v_imported_total := COALESCE(v_imported_total, v_customer_row.imported_total_transaction_baseline, 0);
    v_imported_returns := COALESCE(v_imported_returns, v_customer_row.imported_total_return_baseline, 0);
    v_imported_net := COALESCE(v_imported_net, v_customer_row.imported_net_revenue_baseline,
      v_imported_total - v_imported_returns);
    v_imported_last_order := COALESCE(v_imported_last_order,
      v_customer_row.imported_last_order_at_baseline);
    v_imported_created := COALESCE(v_imported_created,
      v_customer_row.imported_created_at_baseline);

    SELECT max(COALESCE(sale.order_date, sale.confirmed_at, sale.created_at))
    INTO v_operational_last_order
    FROM public.orders sale
    WHERE sale.customer_id = v_customer_id
      AND COALESCE(sale.status, '') NOT IN ('cancelled', 'draft');

    v_debt_delta := v_imported_debt - COALESCE(v_customer_row.imported_debt_baseline, 0);
    v_next_debt := round(COALESCE(v_customer_row.debt, 0) + v_debt_delta);
    v_next_total := round(COALESCE(v_customer_row.total_transaction, 0)
      + v_imported_total - COALESCE(v_customer_row.imported_total_transaction_baseline, 0));
    v_next_returns := round(COALESCE(v_customer_row.total_return, 0)
      + v_imported_returns - COALESCE(v_customer_row.imported_total_return_baseline, 0));
    v_next_net := round(COALESCE(v_customer_row.net_revenue, 0)
      + v_imported_net - COALESCE(v_customer_row.imported_net_revenue_baseline, 0));

    IF v_debt_delta <> 0 THEN
      v_ledger_id := 'DTX-IMPORT-' || gen_random_uuid()::text;
      INSERT INTO public.customer_debt_transactions(
        id, customer_id, transaction_type, amount, debt_change, balance_before,
        balance_after, description, created_by, transaction_date
      ) VALUES (
        v_ledger_id, v_customer_row.id, 'adjust', abs(v_debt_delta), v_debt_delta,
        round(COALESCE(v_customer_row.debt, 0)), v_next_debt,
        'Nhập số dư đầu kỳ từ file khách hàng', v_actor.auth_user_id::text, v_imported_at
      );
    ELSE
      v_ledger_id := NULL;
    END IF;

    UPDATE public.customers
    SET debt = v_next_debt,
        total_transaction = v_next_total,
        total_return = v_next_returns,
        net_revenue = v_next_net,
        last_order_at = CASE
          WHEN NULLIF(v_item->>'lastOrderAt', '') IS NULL THEN v_customer_row.last_order_at
          WHEN v_imported_last_order IS NULL THEN v_operational_last_order
          WHEN v_operational_last_order IS NULL THEN v_imported_last_order
          ELSE GREATEST(v_imported_last_order, v_operational_last_order)
        END,
        created_at = COALESCE(v_imported_created, v_customer_row.created_at),
        imported_debt_baseline = v_imported_debt,
        imported_total_transaction_baseline = v_imported_total,
        imported_total_return_baseline = v_imported_returns,
        imported_net_revenue_baseline = v_imported_net,
        imported_last_order_at_baseline = v_imported_last_order,
        imported_created_at_baseline = v_imported_created,
        financial_baseline_imported_at = v_imported_at,
        updated_at = now(),
        updated_by = v_actor.auth_user_id::text
    WHERE customers.id = v_customer_row.id;

    INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
    VALUES ('customers', 'IMPORT_FINANCIAL_BASELINE', v_customer_row.id,
      jsonb_build_object('debt', v_customer_row.debt, 'total_transaction', v_customer_row.total_transaction,
        'total_return', v_customer_row.total_return, 'net_revenue', v_customer_row.net_revenue,
        'imported_debt_baseline', v_customer_row.imported_debt_baseline,
        'imported_total_transaction_baseline', v_customer_row.imported_total_transaction_baseline,
        'imported_total_return_baseline', v_customer_row.imported_total_return_baseline,
        'imported_net_revenue_baseline', v_customer_row.imported_net_revenue_baseline,
        'created_at', v_customer_row.created_at,
        'imported_created_at_baseline', v_customer_row.imported_created_at_baseline,
        'imported_last_order_at_baseline', v_customer_row.imported_last_order_at_baseline),
      jsonb_build_object('debt', v_next_debt, 'total_transaction', v_next_total,
        'total_return', v_next_returns, 'net_revenue', v_next_net,
        'imported_debt_baseline', v_imported_debt,
        'imported_total_transaction_baseline', v_imported_total,
        'imported_total_return_baseline', v_imported_returns,
        'imported_net_revenue_baseline', v_imported_net,
        'created_at', COALESCE(v_imported_created, v_customer_row.created_at),
        'imported_created_at_baseline', v_imported_created,
        'imported_last_order_at_baseline', v_imported_last_order,
        'ledger_id', v_ledger_id),
      v_actor.auth_user_id::text, now());
    v_processed_count := v_processed_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'processed', v_processed_count);
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_import_customer_financial_baselines(jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_import_customer_financial_baselines(jsonb) TO authenticated;

DO $verify$ BEGIN
  IF (SELECT md5(replace(prosrc,chr(13),'')) FROM pg_proc WHERE oid='public.rpc_import_customer_financial_baselines(jsonb)'::regprocedure) <> '516af2520e9df2335fb1774071cd3dce' THEN
    RAISE EXCEPTION '0115: function verification failed';
  END IF;
END $verify$;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0115','Preserve omitted customer financial baselines and latest dates on reimport') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
