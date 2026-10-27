BEGIN;

-- A commission can be settled in a later payroll period than its cash voucher.
-- The old guard checked order/return links only. Refuse a purge when its source
-- would disappear but the commission belongs to a retained or unknown period.
DO $migration$
DECLARE original text; anchor text; replacement text;
BEGIN
  SELECT replace(pg_get_functiondef('public.p107_preview(boolean)'::regprocedure),chr(13),'') INTO original;
  anchor:=$anchor$IF EXISTS(SELECT 1 FROM public.commission_transactions c WHERE c.salary_period>=to_char(boundary AT TIME ZONE 'Asia/Bangkok','YYYY-MM')
    AND (c.order_id IN(SELECT jsonb_array_elements_text(plan->'orders')) OR c.sales_return_id IN(SELECT jsonb_array_elements_text(plan->'returns')))) THEN$anchor$;
  replacement:=$replacement$IF EXISTS(SELECT 1 FROM public.commission_transactions c
    WHERE (c.salary_period IS NULL OR c.salary_period !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
      OR c.salary_period>=to_char(boundary AT TIME ZONE 'Asia/Bangkok','YYYY-MM'))
    AND (c.order_id IN(SELECT jsonb_array_elements_text(plan->'orders'))
      OR c.sales_return_id IN(SELECT jsonb_array_elements_text(plan->'returns'))
      OR c.cashbook_transaction_id IN(SELECT jsonb_array_elements_text(plan->'cashbook')))) THEN$replacement$;
  -- SQL editors can convert the submitted script itself to CRLF, including
  -- dollar-quoted anchors. Normalize both sides of the contract comparison.
  anchor:=replace(anchor,chr(13),'');
  replacement:=replace(replacement,chr(13),'');
  IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0113: unexpected commission retention guard; installation rolled back'; END IF;
  EXECUTE replace(original,anchor,replacement);
END $migration$;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0113','Block retained or undated commissions before deleting old source cash vouchers') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
