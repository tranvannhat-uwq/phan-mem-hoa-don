BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

-- Filter the read-only history before counting, paging and summarizing.
-- Preserve retained facts and the order/return accounting.
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.rpc_dealer_support_history(text,integer,integer)'::regprocedure);
  archived_source constant text := 'FROM public.dealer_support_history h WHERE h.customer_id=p_customer_id';
  live_source constant text := 'FROM public.p114_source_lines() s WHERE s.customer_id=p_customer_id';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='0123')
     OR EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='0141') THEN
    RAISE EXCEPTION '0141: expected 0123 installed and 0141 pending.';
  END IF;
  IF (length(definition)-length(replace(definition,archived_source,''))) / length(archived_source) <> 2
     OR (length(definition)-length(replace(definition,live_source,''))) / length(live_source) <> 2 THEN
    RAISE EXCEPTION '0141: unexpected dealer support history definition; review before applying.';
  END IF;
  definition := replace(definition,archived_source,archived_source||' AND NOT h.order_cancelled');
  definition := replace(definition,live_source,live_source||' AND NOT s.order_cancelled');
  EXECUTE definition;
END $migration$;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0141','Exclude cancelled orders from dealer support history rows, paging and summaries');
NOTIFY pgrst,'reload schema';
COMMIT;
