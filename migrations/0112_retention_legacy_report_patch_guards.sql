BEGIN;

-- Production can retain the 0066 report and CRLF stored source. Normalize line
-- endings before matching, preserve its pagination contract, and verify every
-- required semantic patch rather than accepting a silent replace() no-op.
DO $migration$
DECLARE original text; patched text; company_anchor text; timeline_anchor text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_get_employee_business_report(jsonb)'::regprocedure) INTO original;
  patched:=replace(original,chr(13),'');
  IF strpos(patched,'public.retention_statement_events ledger')=0
    OR strpos(patched,'retention_separate_return')=0 THEN
    RAISE EXCEPTION '0112: retention employee report prerequisites are missing';
  END IF;
  company_anchor:='AND (requested_company IS NULL OR ledger.retention_company_id=requested_company OR EXISTS (';
  patched:=replace(patched,'AND (requested_company IS NULL OR EXISTS ('||chr(10)||
    '        SELECT 1 FROM public.orders sale WHERE sale.id = ledger.order_id AND sale.company_id = requested_company',
    company_anchor||chr(10)||
    '        SELECT 1 FROM public.orders sale WHERE sale.id = ledger.order_id AND sale.company_id = requested_company');
  timeline_anchor:='''YYYY-MM-DD''), 0, CASE WHEN retention_separate_return THEN -COALESCE(NULLIF(total_refund,0),total_return_amount,0) ELSE 0 END,';
  patched:=replace(patched,'''YYYY-MM-DD''), 0, 0,'||chr(10)||
    '        COALESCE(NULLIF(total_refund, 0), total_return_amount, 0), 0, 0 FROM return_rows',
    timeline_anchor||chr(10)||'        COALESCE(NULLIF(total_refund, 0), total_return_amount, 0), 0, 0 FROM return_rows');
  IF (length(patched)-length(replace(patched,company_anchor,'')))/length(company_anchor)<>2
    OR (length(patched)-length(replace(patched,timeline_anchor,'')))/length(timeline_anchor)<>1 THEN
    RAISE EXCEPTION '0112: company opening or return timeline patch is incomplete; installation rolled back';
  END IF;
  EXECUTE patched;
END $migration$;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0112','Verify legacy employee report company opening and return series patches across line endings') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
