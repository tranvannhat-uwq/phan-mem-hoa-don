BEGIN;

-- A return starts from the immutable unit price saved on each order item.
-- Discounts/support applied to the original order are deliberately ignored;
-- Accounting controls the only reduction through deductionPercent.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
  block_start integer;
  block_end integer;
  block_length integer;
  block_tail constant text := '    END) INTO item_cap;';
  line_break text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_record_sales_return(jsonb)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0070 stopped: rpc_record_sales_return(jsonb) is missing';
  END IF;
  line_break := CASE
    WHEN strpos(current_definition, chr(13) || chr(10)) > 0 THEN chr(13) || chr(10)
    ELSE chr(10)
  END;

  IF current_definition LIKE '%item_cap := round(GREATEST(0, COALESCE(order_item.unit_price, 0)) *%'
     AND current_definition LIKE '%order_return_cap numeric;%' THEN
    RETURN;
  END IF;

  IF current_definition NOT LIKE '%item_deduction_percent numeric;%'
     OR current_definition NOT LIKE '%line_refund := round(line_refund * (100 - item_deduction_percent) / 100);%'
     OR current_definition NOT LIKE '%new_order_returned > COALESCE(sale.total_payable, 0)%' THEN
    RAISE EXCEPTION 'Migration 0070 stopped: record-return function was not recognized';
  END IF;

  patched_definition := replace(current_definition,
    '  item_cap numeric;',
    '  item_cap numeric;' || line_break || '  order_return_cap numeric;');

  block_start := strpos(patched_definition, '    SELECT GREATEST(0, CASE');
  IF block_start = 0 THEN
    RAISE EXCEPTION 'Migration 0070 stopped: record-return item value block is missing';
  END IF;
  block_end := strpos(substring(patched_definition FROM block_start), block_tail);
  IF block_end = 0 THEN
    RAISE EXCEPTION 'Migration 0070 stopped: record-return item value block is incomplete';
  END IF;
  block_length := block_end - 1 + length(block_tail);
  patched_definition := overlay(patched_definition PLACING
    '    item_cap := round(GREATEST(0, COALESCE(order_item.unit_price, 0)) *' || line_break ||
    '      GREATEST(0, COALESCE(order_item.quantity, 0)));'
    FROM block_start FOR block_length);

  patched_definition := replace(patched_definition,
    'COALESCE(order_item.final_unit_price, order_item.unit_price, 0),',
    'COALESCE(order_item.unit_price, 0),');

  patched_definition := replace(patched_definition,
    '  new_order_returned := existing_returned + v_total_refund;' || line_break ||
    '  IF new_order_returned > COALESCE(sale.total_payable, 0) THEN' || line_break ||
    '    RAISE EXCEPTION ''Return value exceeds the remaining order value'';' || line_break ||
    '  END IF;',
    '  new_order_returned := existing_returned + v_total_refund;' || line_break ||
    '  SELECT COALESCE(sum(round(' || line_break ||
    '    GREATEST(0, COALESCE(item.quantity, 0)) *' || line_break ||
    '    GREATEST(0, COALESCE(item.unit_price, 0))' || line_break ||
    '  )), 0) INTO order_return_cap' || line_break ||
    '  FROM public.order_items item' || line_break ||
    '  WHERE item.order_id = sale.id;' || line_break ||
    '  IF new_order_returned > order_return_cap THEN' || line_break ||
    '    RAISE EXCEPTION ''Return value exceeds the gross order-item value'';' || line_break ||
    '  END IF;');

  patched_definition := replace(patched_definition,
    '    IF COALESCE(customer_row.net_revenue, 0) < v_total_refund' || line_break ||
    '       OR COALESCE(customer_row.total_transaction, 0) < v_total_refund THEN' || line_break ||
    '      RAISE EXCEPTION ''Customer revenue aggregates are inconsistent; return stopped for review'';' || line_break ||
    '    END IF;' || line_break,
    '');

  patched_definition := replace(patched_definition,
    'net_revenue = GREATEST(0, COALESCE(total_payable, 0) - new_order_returned),',
    'net_revenue = COALESCE(total_payable, 0) - new_order_returned,');

  patched_definition := replace(patched_definition,
    '      WHEN new_order_returned = sale.total_payable THEN COALESCE(commission_original.commission_amount, 0)',
    '      WHEN COALESCE(sale.total_payable, 0) <= 0 THEN 0' || line_break ||
    '      WHEN new_order_returned >= sale.total_payable THEN COALESCE(commission_original.commission_amount, 0)');
  patched_definition := replace(patched_definition,
    '      WHEN new_order_returned = sale.total_payable THEN COALESCE(commission_original.basis_amount, 0)',
    '      WHEN COALESCE(sale.total_payable, 0) <= 0 THEN 0' || line_break ||
    '      WHEN new_order_returned >= sale.total_payable THEN COALESCE(commission_original.basis_amount, 0)');

  IF patched_definition = current_definition
     OR patched_definition NOT LIKE '%order_return_cap numeric;%'
     OR patched_definition NOT LIKE '%item_cap := round(GREATEST(0, COALESCE(order_item.unit_price, 0)) *%'
     OR patched_definition NOT LIKE '%line_refund := round(line_refund * (100 - item_deduction_percent) / 100);%'
     OR patched_definition NOT LIKE '%IF new_order_returned > order_return_cap THEN%'
     OR patched_definition LIKE '%new_order_returned > COALESCE(sale.total_payable, 0)%'
     OR patched_definition LIKE '%Customer revenue aggregates are inconsistent; return stopped for review%'
     OR patched_definition LIKE '%COALESCE(order_item.final_unit_price, order_item.unit_price, 0)%'
     OR patched_definition NOT LIKE '%net_revenue = COALESCE(total_payable, 0) - new_order_returned,%'
     OR patched_definition NOT LIKE '%WHEN new_order_returned >= sale.total_payable THEN COALESCE(commission_original.commission_amount, 0)%' THEN
    RAISE EXCEPTION 'Migration 0070 stopped: record-return patch was incomplete';
  END IF;

  EXECUTE patched_definition;
END
$migration$;

-- Cancelling a return rebuilds item totals from the same gross unit-price basis
-- and never reverses more commission than the original order earned.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
  block_start integer;
  block_end integer;
  block_length integer;
  block_tail constant text := '    END) INTO item_cap;';
  line_break text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_cancel_sales_return(text,text)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0070 stopped: rpc_cancel_sales_return(text,text) is missing';
  END IF;
  line_break := CASE
    WHEN strpos(current_definition, chr(13) || chr(10)) > 0 THEN chr(13) || chr(10)
    ELSE chr(10)
  END;

  IF current_definition LIKE '%item_cap := round(GREATEST(0, COALESCE(order_item.unit_price, 0)) *%' THEN
    RETURN;
  END IF;

  IF current_definition NOT LIKE '%sum(other_item.subtotal)%INTO remaining_amount%'
     OR current_definition NOT LIKE '%SELECT GREATEST(0, CASE%END) INTO item_cap;%' THEN
    RAISE EXCEPTION 'Migration 0070 stopped: cancel-return function was not recognized';
  END IF;

  patched_definition := current_definition;
  block_start := strpos(patched_definition, '    SELECT GREATEST(0, CASE');
  IF block_start = 0 THEN
    RAISE EXCEPTION 'Migration 0070 stopped: cancel-return item value block is missing';
  END IF;
  block_end := strpos(substring(patched_definition FROM block_start), block_tail);
  IF block_end = 0 THEN
    RAISE EXCEPTION 'Migration 0070 stopped: cancel-return item value block is incomplete';
  END IF;
  block_length := block_end - 1 + length(block_tail);
  patched_definition := overlay(patched_definition PLACING
    '    item_cap := round(GREATEST(0, COALESCE(order_item.unit_price, 0)) *' || line_break ||
    '      GREATEST(0, COALESCE(order_item.quantity, 0)));'
    FROM block_start FOR block_length);

  patched_definition := replace(patched_definition,
    'net_revenue = GREATEST(0, COALESCE(total_payable, 0) - new_returned_amount),',
    'net_revenue = COALESCE(total_payable, 0) - new_returned_amount,');
  patched_definition := replace(patched_definition,
    '      WHEN new_returned_amount = sale.total_payable THEN COALESCE(commission_original.commission_amount, 0)',
    '      WHEN COALESCE(sale.total_payable, 0) <= 0 THEN 0' || line_break ||
    '      WHEN new_returned_amount >= sale.total_payable THEN COALESCE(commission_original.commission_amount, 0)');
  patched_definition := replace(patched_definition,
    '      WHEN new_returned_amount = sale.total_payable THEN COALESCE(commission_original.basis_amount, 0)',
    '      WHEN COALESCE(sale.total_payable, 0) <= 0 THEN 0' || line_break ||
    '      WHEN new_returned_amount >= sale.total_payable THEN COALESCE(commission_original.basis_amount, 0)');

  IF patched_definition = current_definition
     OR patched_definition NOT LIKE '%item_cap := round(GREATEST(0, COALESCE(order_item.unit_price, 0)) *%'
     OR patched_definition NOT LIKE '%sum(other_item.subtotal)%INTO remaining_amount%'
     OR patched_definition NOT LIKE '%net_revenue = COALESCE(total_payable, 0) - new_returned_amount,%'
     OR patched_definition NOT LIKE '%WHEN new_returned_amount >= sale.total_payable THEN COALESCE(commission_original.commission_amount, 0)%' THEN
    RAISE EXCEPTION 'Migration 0070 stopped: cancel-return patch was incomplete';
  END IF;

  EXECUTE patched_definition;
END
$migration$;

ALTER FUNCTION public.rpc_record_sales_return(jsonb) SECURITY DEFINER;
ALTER FUNCTION public.rpc_record_sales_return(jsonb) SET search_path = pg_catalog, public;
ALTER FUNCTION public.rpc_cancel_sales_return(text, text) SECURITY DEFINER;
ALTER FUNCTION public.rpc_cancel_sales_return(text, text) SET search_path = pg_catalog, public;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'rpc_record_sales_return'
      AND pg_get_function_identity_arguments(procedure.oid) = 'p_input jsonb'
      AND procedure.prosrc LIKE '%item_cap := round(GREATEST(0, COALESCE(order_item.unit_price, 0)) *%'
      AND procedure.prosrc LIKE '%line_refund := round(line_refund * (100 - item_deduction_percent) / 100);%'
      AND procedure.prosrc LIKE '%IF new_order_returned > order_return_cap THEN%'
      AND procedure.prosrc NOT LIKE '%sale.total_payable / sale.subtotal%'
      AND procedure.prosrc NOT LIKE '%Customer revenue aggregates are inconsistent; return stopped for review%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0070 stopped: record-return unit-price rule was not verified';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'rpc_cancel_sales_return'
      AND pg_get_function_identity_arguments(procedure.oid) = 'p_return_id text, p_reason text'
      AND procedure.prosrc LIKE '%item_cap := round(GREATEST(0, COALESCE(order_item.unit_price, 0)) *%'
      AND procedure.prosrc LIKE '%sum(other_item.subtotal)%INTO remaining_amount%'
      AND procedure.prosrc NOT LIKE '%sale.total_payable / sale.subtotal%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0070 stopped: cancel-return unit-price rule was not verified';
  END IF;
END
$migration$;

REVOKE ALL ON FUNCTION public.rpc_record_sales_return(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_sales_return(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_record_sales_return(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sales_return(text, text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0070', 'Use saved order unit prices as the gross basis for sales returns')
ON CONFLICT (version) DO NOTHING;

COMMIT;
