BEGIN;

-- This catalog is intentionally separate from public.product_groups. The
-- latter represents a technical product family and is created automatically
-- when variants are saved. Payroll groups are accounting-owned business
-- classifications and must only be created explicitly by a finance user.
CREATE TABLE IF NOT EXISTS public.payroll_product_groups (
  id text PRIMARY KEY,
  code text NOT NULL CHECK (btrim(code) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS payroll_product_groups_code_unique
  ON public.payroll_product_groups (lower(btrim(code)));
CREATE UNIQUE INDEX IF NOT EXISTS payroll_product_groups_name_unique
  ON public.payroll_product_groups (lower(btrim(name)));

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS payroll_product_group_id text;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'products_payroll_product_group_id_fkey'
      AND conrelid = 'public.products'::regclass
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_payroll_product_group_id_fkey
      FOREIGN KEY (payroll_product_group_id)
      REFERENCES public.payroll_product_groups(id)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
  END IF;
END
$migration$;

CREATE INDEX IF NOT EXISTS products_payroll_product_group_id_idx
  ON public.products(payroll_product_group_id);

-- Keep the legacy text column as a display snapshot for older clients. It is
-- never used to create a catalog entry and therefore cannot bypass the FK.
CREATE OR REPLACE FUNCTION public.p73_sync_product_payroll_group_name()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  group_name text;
BEGIN
  IF NEW.payroll_product_group_id IS NULL OR btrim(NEW.payroll_product_group_id) = '' THEN
    NEW.payroll_product_group_id := NULL;
    NEW.product_group := NULL;
    RETURN NEW;
  END IF;

  SELECT payroll_group.name
    INTO group_name
  FROM public.payroll_product_groups payroll_group
  WHERE payroll_group.id = NEW.payroll_product_group_id;

  IF group_name IS NULL THEN
    RAISE EXCEPTION 'Nhóm sản phẩm tính lương không tồn tại: %', NEW.payroll_product_group_id
      USING ERRCODE = '23503';
  END IF;

  NEW.product_group := group_name;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS products_sync_payroll_group_name_p73 ON public.products;
CREATE TRIGGER products_sync_payroll_group_name_p73
BEFORE INSERT OR UPDATE OF payroll_product_group_id ON public.products
FOR EACH ROW EXECUTE FUNCTION public.p73_sync_product_payroll_group_name();

CREATE OR REPLACE FUNCTION public.p73_refresh_products_after_payroll_group_rename()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    UPDATE public.products
    SET product_group = NEW.name,
        updated_at = now()
    WHERE payroll_product_group_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payroll_group_rename_refresh_products_p73
  ON public.payroll_product_groups;
CREATE TRIGGER payroll_group_rename_refresh_products_p73
AFTER UPDATE OF name ON public.payroll_product_groups
FOR EACH ROW EXECUTE FUNCTION public.p73_refresh_products_after_payroll_group_rename();

ALTER TABLE public.payroll_product_groups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payroll_product_groups FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payroll_product_groups TO authenticated;

DROP POLICY IF EXISTS payroll_product_groups_select ON public.payroll_product_groups;
CREATE POLICY payroll_product_groups_select
ON public.payroll_product_groups FOR SELECT TO authenticated
USING (public.current_profile_role() IS NOT NULL);

DROP POLICY IF EXISTS payroll_product_groups_finance_insert ON public.payroll_product_groups;
CREATE POLICY payroll_product_groups_finance_insert
ON public.payroll_product_groups FOR INSERT TO authenticated
WITH CHECK (public.is_admin_or_accounting());

DROP POLICY IF EXISTS payroll_product_groups_finance_update ON public.payroll_product_groups;
CREATE POLICY payroll_product_groups_finance_update
ON public.payroll_product_groups FOR UPDATE TO authenticated
USING (public.is_admin_or_accounting())
WITH CHECK (public.is_admin_or_accounting());

REVOKE ALL ON FUNCTION public.p73_sync_product_payroll_group_name() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.p73_refresh_products_after_payroll_group_rename() FROM PUBLIC, anon, authenticated;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'payroll_product_groups'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.payroll_product_groups;
  END IF;
END
$migration$;

-- Deliberately no INSERT ... SELECT from products.product_group: existing free
-- text is not promoted into an accounting catalog automatically.
INSERT INTO public.schema_migrations(version, description)
VALUES ('0073', 'Manual accounting-owned product groups for payroll exports')
ON CONFLICT (version) DO NOTHING;

COMMIT;
