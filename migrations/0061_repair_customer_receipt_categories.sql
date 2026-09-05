BEGIN;

-- Migration 0061: Repair cashbook categories and notes corrupted by the legacy note template bug
-- Rows created by the previous bug had note ending in '- TTM00000x' and category = 'Thu tiền khách hàng'.
-- We restore their intended category from the note prefix and clean the auto-generated note.

UPDATE public.cashbook_transactions
SET category = btrim(regexp_replace(regexp_replace(note, '^HD:\s*', '', 'i'), '\s*-\s*TTM\d+$', '', 'i')),
    note = NULL
WHERE (category = 'Thu tiền khách hàng' OR category = 'Thu tiền khách hàng / Trả trước' OR category IS NULL)
  AND note ~* '\s*-\s*TTM\d+$';

-- Also repair customer_debt_transactions descriptions that inherited the corrupted note
UPDATE public.customer_debt_transactions debt
SET description = cb.category
FROM public.cashbook_transactions cb
WHERE debt.cashbook_transaction_id = cb.id
  AND debt.description ~* '\s*-\s*TTM\d+$'
  AND cb.category IS NOT NULL;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0061', 'Repair cashbook categories and notes corrupted by legacy note template')
ON CONFLICT (version) DO NOTHING;

COMMIT;
