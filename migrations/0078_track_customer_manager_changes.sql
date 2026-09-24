BEGIN;

-- Customer-manager reassignment is business-significant and must survive
-- Activity Log and audit payload compaction.
CREATE OR REPLACE FUNCTION public.p52_is_important_change_field(p_key text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT lower(COALESCE(p_key, '')) = ANY (ARRAY[
    'status', 'notes', 'note', 'reason', 'role', 'is_active', 'items',
    'type', 'transaction_type', 'operation_type', 'category', 'partner',
    'method', 'payment_method', 'payment_status', 'accounting', 'quantity',
    'cash', 'bank', 'wallet', 'customer_id', 'supplier_id', 'order_id',
    'counterparty_type', 'counterparty_id', 'collector_id', 'collector_name',
    'transaction_date', 'managed_by'
  ]) OR lower(COALESCE(p_key, '')) ~
    '(price|amount|total|subtotal|debt|refund|discount|fee|value|paid|product|variant|sku|unit|package)';
$$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0078', 'Preserve customer-manager changes in audit and activity logs')
ON CONFLICT (version) DO NOTHING;

COMMIT;
