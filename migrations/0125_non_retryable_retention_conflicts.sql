BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';

-- 40001 is a serialization failure. PostgREST 14 may retry it forever, so
-- application conflicts must return HTTP 409 instead. Keep every epoch,
-- fingerprint, advisory lock and backup validation exactly as before.
DO $patch$
DECLARE signature text; original text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.p107_assert_epoch()',
    'public.rpc_execute_monthly_retention(uuid,text,text)',
    'public.rpc_stage_retention_backup_table(uuid,text)',
    'public.rpc_finish_retention_backup(uuid)'
  ] LOOP
    SELECT pg_get_functiondef(signature::regprocedure) INTO original;
    IF strpos(original, '''40001''') > 0 THEN
      EXECUTE replace(original, '''40001''', '''PT409''');
    ELSIF strpos(original, '''PT409''') = 0 THEN
      RAISE EXCEPTION '0125: unexpected conflict contract in %', signature;
    END IF;
  END LOOP;
END
$patch$;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0125','Return non-retryable HTTP 409 for stale retention epochs and changed backup fingerprints')
ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
