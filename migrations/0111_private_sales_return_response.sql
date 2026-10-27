BEGIN;

-- 0055 accidentally re-granted this SECURITY DEFINER serializer to API users.
-- It does not authenticate or enforce customer scope itself. Only the reviewed
-- financial/list RPCs should call it, under their existing definer privileges.
-- No rows, document amounts, customer balances or function bodies are changed.
REVOKE ALL ON FUNCTION public.p3_sales_return_response(text) FROM PUBLIC, anon, authenticated;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0111','Keep sales return response serializer private to scoped RPCs') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
