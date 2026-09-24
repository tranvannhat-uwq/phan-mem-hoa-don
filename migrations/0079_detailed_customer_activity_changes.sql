BEGIN;

-- Preserve editable customer-profile details in both compact audit payloads
-- and the Admin-facing Activity Log. Scope these fields to customers so
-- similarly named fields in other modules keep the existing compact policy.
CREATE OR REPLACE FUNCTION public.p79_is_customer_detail_field(p_key text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT lower(COALESCE(p_key, '')) = ANY (ARRAY[
    'code', 'name', 'phone', 'phone2', 'email', 'facebook', 'birthday',
    'gender', 'avatar_url', 'province', 'ward', 'customer_group_id',
    'company_name', 'tax_code', 'invoice_address', 'address', 'status',
    'assigned_brand', 'brand_discounts', 'shipping_support', 'notes',
    'pricelist_id', 'default_price_list_id', 'managed_by'
  ]);
$$;

CREATE OR REPLACE FUNCTION public.p52_compact_changes(p_changes jsonb, p_context text DEFAULT '')
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN '{}'::jsonb ELSE COALESCE((
    SELECT jsonb_object_agg(entry.key, CASE
      WHEN lower(entry.key) = 'items' THEN jsonb_build_object(
        'old', public.p52_compact_items(entry.value->'old'),
        'new', public.p52_compact_items(entry.value->'new')
      )
      ELSE entry.value
    END)
    FROM jsonb_each(p_changes) entry
    WHERE public.p52_is_important_change_field(entry.key)
       OR (lower(COALESCE(p_context, '')) IN ('products', 'product', 'price_list_items', 'pricelists')
           AND public.p52_is_product_identity_field(entry.key))
       OR (lower(COALESCE(p_context, '')) = 'customers'
           AND public.p79_is_customer_detail_field(entry.key))
  ), '{}'::jsonb) END;
$$;

CREATE OR REPLACE FUNCTION public.p79_compact_audit_payload(p_payload jsonb, p_context text)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN NULL
    ELSE COALESCE(public.p52_compact_audit_payload(p_payload), '{}'::jsonb) ||
      CASE WHEN lower(COALESCE(p_context, '')) = 'customers' THEN COALESCE((
        SELECT jsonb_object_agg(entry.key, entry.value)
        FROM jsonb_each(p_payload) entry
        WHERE public.p79_is_customer_detail_field(entry.key)
      ), '{}'::jsonb) ELSE '{}'::jsonb END
  END;
$$;

CREATE OR REPLACE FUNCTION public.p52_filter_audit_row()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE compact_old jsonb; compact_new jsonb; meaningful_changes jsonb;
BEGIN
  compact_old := public.p79_compact_audit_payload(NEW.old_data, NEW.table_name);
  compact_new := public.p79_compact_audit_payload(NEW.new_data, NEW.table_name);
  meaningful_changes := public.p52_compact_changes(
    public.p36_activity_changes(COALESCE(compact_old, '{}'::jsonb), COALESCE(compact_new, '{}'::jsonb)),
    NEW.table_name
  );
  IF meaningful_changes = '{}'::jsonb AND NOT public.p52_is_essential_action(NEW.action) THEN RETURN NULL; END IF;
  NEW.old_data := NULLIF(compact_old, '{}'::jsonb);
  NEW.new_data := NULLIF(compact_new, '{}'::jsonb);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Audit compaction skipped one log row: %', SQLERRM;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.p79_is_customer_detail_field(text),
  public.p79_compact_audit_payload(jsonb,text)
FROM PUBLIC, anon, authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0079', 'Preserve detailed customer profile changes in activity logs')
ON CONFLICT (version) DO NOTHING;

COMMIT;
