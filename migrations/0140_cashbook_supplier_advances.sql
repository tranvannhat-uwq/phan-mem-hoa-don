BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

-- Install rules only. An advance is already represented by negative supplier
-- debt, so later purchases consume it through p4_recompute_supplier.
DO $migration$
DECLARE
  reconcile_def text := pg_get_functiondef('public.rpc_reconcile_supplier_cashbook_payment(text,text)'::regprocedure);
  create_def text := pg_get_functiondef('public.rpc_create_supplier_cashbook_payment(jsonb)'::regprocedure);
  amend_def text := pg_get_functiondef('public.rpc_amend_cashbook_transaction(text,jsonb)'::regprocedure);
  reconcile_signature constant text := 'CREATE OR REPLACE FUNCTION public.rpc_reconcile_supplier_cashbook_payment(p_cashbook_id text, p_supplier_id text)';
  debt_guard constant text := 'IF entry.value>supplier_row.debt THEN';
  payment_key constant text := 'request_key:=''cashbook-supplier:''||md5(entry.id);';
  create_link constant text := 'public.rpc_reconcile_supplier_cashbook_payment(created->>''cashbook_id'',supplier_row.id)';
  amend_guard constant text := 'IF supplier_payment.purchase_id IS NULL AND next_value > round(COALESCE(old_supplier.debt, 0)) + round(entry.value) THEN';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0137')
     OR EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0140') THEN
    RAISE EXCEPTION '0140: expected 0137 installed and 0140 pending.';
  END IF;
  IF strpos(reconcile_def, reconcile_signature) <> 1
     OR strpos(reconcile_def, debt_guard) = 0
     OR strpos(reconcile_def, payment_key) = 0
     OR strpos(create_def, create_link) = 0
     OR strpos(amend_def, amend_guard) = 0 THEN
    RAISE EXCEPTION '0140: unexpected cashbook function definitions; review before applying.';
  END IF;

  -- Keep one implementation for linking payments. The internal option is
  -- enabled only when creating a voucher in the same transaction.
  reconcile_def := replace(reconcile_def, reconcile_signature,
    'CREATE FUNCTION public.p140_link_supplier_cashbook_payment(p_cashbook_id text, p_supplier_id text, p_allow_advance boolean)');
  reconcile_def := replace(reconcile_def, '-- Preserve the same outstanding-debt limit as unallocated supplier payments.',
    '-- Keep the outstanding-debt limit when reconciling an existing voucher.');
  reconcile_def := replace(reconcile_def, debt_guard, 'IF p_allow_advance IS NOT TRUE AND entry.value>supplier_row.debt THEN');
  reconcile_def := replace(reconcile_def, payment_key,
    'request_key:=CASE WHEN p_allow_advance THEN ''cashbook-supplier-advance:'' ELSE ''cashbook-supplier:'' END||md5(entry.id);');
  EXECUTE reconcile_def;

  EXECUTE replace(create_def, create_link,
    'public.p140_link_supplier_cashbook_payment(created->>''cashbook_id'',supplier_row.id,true)');

  -- Recognize payments created by the new rule using their server-generated
  -- key. Edits retain that key; pre-existing payments keep their current rules.
  EXECUTE replace(amend_def, amend_guard,
    'IF supplier_payment.purchase_id IS NULL
        AND (next_value::text IN (''NaN'', ''Infinity'', ''-Infinity'')
          OR (supplier_payment.idempotency_key IS DISTINCT FROM (''cashbook-supplier-advance:'' || md5(entry.id))
            AND next_value > round(COALESCE(old_supplier.debt, 0)) + round(entry.value))) THEN');
END $migration$;

REVOKE ALL ON FUNCTION public.p140_link_supplier_cashbook_payment(text,text,boolean) FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION public.rpc_reconcile_supplier_cashbook_payment(p_cashbook_id text,p_supplier_id text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.p140_link_supplier_cashbook_payment(p_cashbook_id,p_supplier_id,false)
$$;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0140','Carry overpayments on new supplier cashbook vouchers as supplier advances');
NOTIFY pgrst,'reload schema';
COMMIT;
