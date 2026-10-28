BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';

-- One bounded directory page, including dates derived from complete retained
-- records. Never download purchase items or use a truncated browser history.
CREATE OR REPLACE FUNCTION public.rpc_supplier_directory(p_offset integer DEFAULT 0,p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE actor public.profiles%ROWTYPE; result jsonb;
  safe_limit integer:=LEAST(GREATEST(COALESCE(p_limit,200),1),200);
BEGIN
  actor:=public.require_authenticated_profile();
  IF actor.role NOT IN ('admin','accounting') THEN RAISE EXCEPTION 'Không có quyền xem nhà cung cấp.' USING ERRCODE='42501'; END IF;
  IF p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Invalid supplier offset.' USING ERRCODE='22023'; END IF;
  SELECT jsonb_build_object('rows',COALESCE(jsonb_agg(to_jsonb(s)||jsonb_build_object(
    'last_purchase_at',(SELECT p.purchase_date FROM public.purchases p WHERE p.supplier_id=s.id AND p.status='completed' ORDER BY p.purchase_date DESC LIMIT 1),
    'last_payment_at',(SELECT p.created_at FROM public.purchase_payments p WHERE p.supplier_id=s.id AND p.status='completed' ORDER BY p.created_at DESC LIMIT 1)) ORDER BY s.id),'[]'::jsonb),
    'total',(SELECT count(*) FROM public.suppliers WHERE is_active)) INTO result
  FROM (SELECT * FROM public.suppliers WHERE is_active ORDER BY id OFFSET p_offset LIMIT safe_limit) s;
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.rpc_supplier_directory(integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_supplier_directory(integer,integer) TO authenticated;

-- Keep dates current after save, purchase, payment or cancellation as well as
-- on a full refresh. Replacing the body preserves this private helper's ACL.
DO $patch$
DECLARE original text; anchor text:='''createdBy'', supplier.created_by, ''updatedBy'', supplier.updated_by';
BEGIN
  SELECT pg_get_functiondef('public.p4_supplier_response(text)'::regprocedure) INTO original;
  IF strpos(original, '''lastPurchaseAt''')=0 THEN
    IF strpos(original,anchor)=0 THEN RAISE EXCEPTION '0126: supplier response contract changed'; END IF;
    EXECUTE replace(original,anchor,anchor||',
      ''createdAt'', supplier.created_at, ''updatedAt'', supplier.updated_at,
      ''lastPurchaseAt'', (SELECT purchase_date FROM public.purchases WHERE supplier_id=supplier.id AND status=''completed'' ORDER BY purchase_date DESC LIMIT 1),
      ''lastPaymentAt'', (SELECT created_at FROM public.purchase_payments WHERE supplier_id=supplier.id AND status=''completed'' ORDER BY created_at DESC LIMIT 1)');
  END IF;
END
$patch$;
INSERT INTO public.schema_migrations(version,description)
VALUES ('0126','Bounded finance-only supplier directory with authoritative created, updated and latest retained transaction dates') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
