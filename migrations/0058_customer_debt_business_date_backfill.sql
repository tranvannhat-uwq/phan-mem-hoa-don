BEGIN;

-- Older finalized-order amendments created a replacement row on the edit day.
-- Keep created_at as the immutable posting/audit timestamp, but align the
-- document timestamp with the authoritative invoice business date.
UPDATE public.customer_debt_transactions ledger
SET transaction_date = sale.order_date
FROM public.orders sale
WHERE ledger.order_id = sale.id
  AND ledger.transaction_type IN ('order', 'order_cancel', 'order_amend')
  AND ledger.transaction_date IS DISTINCT FROM sale.order_date;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0058', 'Align order debt document dates with authoritative invoice business dates')
ON CONFLICT(version) DO NOTHING;

COMMIT;
