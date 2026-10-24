BEGIN;

-- New returns are retained as customer credit, including when debt is zero
-- or already negative. Do not rewrite historical refunds or cash vouchers.
DO $migration$
DECLARE original text; patched text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_record_sales_return(jsonb)'::regprocedure) INTO original;
  IF original NOT LIKE '%debt_reduction := LEAST(v_total_refund, GREATEST(balance_before, 0));%'
    OR original NOT LIKE '%cash_refund := v_total_refund - debt_reduction;%'
    OR original NOT LIKE '%balance_after := balance_before - debt_reduction;%'
    OR original NOT LIKE '%order_return_cap numeric;%' THEN
    RAISE EXCEPTION 'Migration 0103 stopped: expected the 0070 return calculation with debt/cash split.';
  END IF;
  patched := replace(original,
    'debt_reduction := LEAST(v_total_refund, GREATEST(balance_before, 0));',
    'debt_reduction := v_total_refund;');
  patched := replace(patched, 'cash_refund := v_total_refund - debt_reduction;',
    'cash_refund := 0; -- Retain the entire return as customer credit.');
  IF patched = original OR patched LIKE '%debt_reduction := LEAST(v_total_refund,%' THEN
    RAISE EXCEPTION 'Migration 0103 stopped: return credit patch was incomplete.';
  END IF;
  EXECUTE patched;
END $migration$;

-- Explicit capability prevents a new browser from unknowingly using the old
-- auto-refund policy when this migration has not been installed yet.
CREATE FUNCTION public.rpc_record_sales_return_credit(p_input jsonb) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.rpc_record_sales_return(p_input)
$$;
REVOKE ALL ON FUNCTION public.rpc_record_sales_return_credit(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_sales_return_credit(jsonb) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0103', 'Retain new sales returns as signed customer credit instead of automatic cash refunds');
COMMIT;
