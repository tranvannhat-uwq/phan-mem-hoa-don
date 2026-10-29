BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='60s';

DO $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version='0013')
     OR to_regprocedure('public.p2_cashbook_response(text)') IS NULL THEN
    RAISE EXCEPTION 'Migration 0135 requires migration 0013 and the cashbook response function.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.schema_migrations WHERE version='0135') THEN
    RAISE EXCEPTION 'Migration 0135 is already recorded.';
  END IF;
END $guard$;

-- Allocate once for every existing voucher and every future insert, including
-- supplier payments and reversals. No financial ID, amount or reference changes.
-- The default is evaluated for existing rows by ALTER TABLE, without UPDATE
-- triggers or financial audit entries. Numbers are never reassigned on edits.
CREATE SEQUENCE public.cashbook_voucher_display_seq;
REVOKE ALL ON SEQUENCE public.cashbook_voucher_display_seq FROM PUBLIC,anon,authenticated;
ALTER TABLE public.cashbook_transactions
  ADD COLUMN display_number bigint DEFAULT nextval('public.cashbook_voucher_display_seq'::regclass);
ALTER SEQUENCE public.cashbook_voucher_display_seq OWNED BY public.cashbook_transactions.display_number;
ALTER TABLE public.cashbook_transactions ADD CONSTRAINT cashbook_display_number_positive CHECK(display_number > 0);
CREATE UNIQUE INDEX cashbook_display_number_unique ON public.cashbook_transactions(display_number)
  WHERE display_number IS NOT NULL;

-- Existing snapshots and date-window reads already select entry.*. Add the
-- number to canonical command responses so a freshly saved voucher uses it too.
DO $response$
DECLARE definition text;
  anchor text := '''id'', entry.id, ''cloudId'', entry.id,';
BEGIN
  definition := pg_get_functiondef('public.p2_cashbook_response(text)'::regprocedure);
  IF strpos(definition,anchor)=0 THEN
    RAISE EXCEPTION '0135: unexpected cashbook response shape; review before migrating.';
  END IF;
  EXECUTE replace(definition,anchor,anchor||' ''displayNumber'', entry.display_number::text, ''externalReference'', entry.external_reference,');
END $response$;

INSERT INTO public.schema_migrations(version,description)
VALUES('0135','Stable short PT/PC display numbers without changing cashbook identities');
NOTIFY pgrst,'reload schema';
COMMIT;
