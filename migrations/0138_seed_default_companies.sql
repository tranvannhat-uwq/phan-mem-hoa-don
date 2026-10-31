BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

-- The UI has always offered these IDs from DEFAULT_COMPANIES in js/state.js.
-- The core schema created an empty companies table, so independent returns
-- rejected valid UI selections. Populate missing master rows while retaining
-- the existing server-side company validation and any customized company data.
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0106') THEN
    RAISE EXCEPTION 'Migration 0138 requires migration 0106.';
  END IF;
END $guard$;

INSERT INTO public.companies (id, code, name, address, status)
VALUES
  ('ABS_NORTH', 'ABS_NORTH', 'Công ty Cổ phần ABS JAPAN (Miền Bắc)', 'Tiên Kha - Phúc Thịnh - Hà Nội', 'active'),
  ('ABS_SOUTH', 'ABS_SOUTH', 'Công ty Cổ phần ABS JAPAN - Chi nhánh Miền Nam', '228 Hoàng Hữu Nam - P.Long Bình - Hồ Chí Minh', 'active'),
  ('EMP_USA', 'EMP_USA', 'Công ty Cổ phần EMP Hoa Kỳ', 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.schema_migrations (version, description)
VALUES ('0138', 'Seed missing default companies so independent returns accept existing UI company IDs')
ON CONFLICT (version) DO NOTHING;
COMMIT;
