BEGIN;

-- Installation is additive. No business rows are deleted until an Admin
-- explicitly executes a fresh, backup-bound job through the RPC below.
CREATE TABLE public.retention_control (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
  cutoff timestamptz,
  cash_carry numeric NOT NULL DEFAULT 0,
  bank_carry numeric NOT NULL DEFAULT 0,
  wallet_carry numeric NOT NULL DEFAULT 0,
  expected_trigger_hash text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.retention_control(id) VALUES (true);
-- Core draft tables were copied without a primary key. Published deletes
-- require a replica identity even when no rows match a DELETE statement.
ALTER TABLE public.draft_orders REPLICA IDENTITY USING INDEX draft_orders_id_uidx;
CREATE TABLE public.retention_customer_balances (
  customer_id text PRIMARY KEY REFERENCES public.customers(id) ON DELETE CASCADE,
  cutoff timestamptz NOT NULL,
  debt_opening numeric NOT NULL,
  payment_carry numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.retention_supplier_balances (
  supplier_id text PRIMARY KEY REFERENCES public.suppliers(id) ON DELETE CASCADE,
  purchase_carry numeric NOT NULL DEFAULT 0,
  paid_carry numeric NOT NULL DEFAULT 0,
  cutoff timestamptz NOT NULL
);
CREATE TABLE public.retention_customer_company_balances (
  customer_id text NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  company_id text NOT NULL,
  debt_opening numeric NOT NULL,
  cutoff timestamptz NOT NULL,
  PRIMARY KEY(customer_id,company_id)
);
CREATE TABLE public.retention_inventory_balances (
  product_id text PRIMARY KEY REFERENCES public.products(id) ON DELETE RESTRICT,
  quantity_opening numeric NOT NULL,
  cutoff timestamptz NOT NULL
);
CREATE TABLE public.retention_jobs (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  cutoff timestamptz NOT NULL,
  include_archive boolean NOT NULL,
  epoch_before bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('prepared', 'executing', 'completed')),
  fingerprint text NOT NULL,
  backup_sha256 text NOT NULL,
  preview jsonb NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  backend_pid integer,
  transaction_id bigint
);
-- Irreversible request digests prevent delayed retries from recreating purged
-- documents. No customer identity, document body or monetary value is stored.
CREATE TABLE public.retention_retired_requests (
  digest text PRIMARY KEY CHECK (length(digest) = 64)
);

DO $migration$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['retention_control', 'retention_customer_balances',
    'retention_supplier_balances', 'retention_customer_company_balances', 'retention_inventory_balances', 'retention_jobs', 'retention_retired_requests'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', target);
  END LOOP;
END $migration$;
GRANT SELECT ON public.retention_customer_balances TO authenticated;
CREATE POLICY retention_customer_read ON public.retention_customer_balances
FOR SELECT TO authenticated USING (public.can_access_customer(customer_id));

CREATE FUNCTION public.p107_cutoff() RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT (date_trunc('month', now() AT TIME ZONE 'Asia/Bangkok') - interval '1 month') AT TIME ZONE 'Asia/Bangkok'
$$;

CREATE FUNCTION public.p107_require_admin() RETURNS public.profiles
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor public.profiles%ROWTYPE;
BEGIN
  SELECT * INTO actor FROM public.profiles WHERE auth_user_id = auth.uid() AND is_active;
  IF actor.id IS NULL OR actor.role <> 'admin' THEN
    RAISE EXCEPTION 'Chỉ Admin được dọn dữ liệu.' USING ERRCODE='42501';
  END IF;
  RETURN actor;
END $$;

CREATE FUNCTION public.p107_is_executing() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (SELECT 1 FROM public.retention_jobs j
    WHERE j.id::text = current_setting('app.retention_job', true)
      AND j.state = 'executing' AND j.actor_id = auth.uid()
      AND j.backend_pid = pg_backend_pid() AND j.transaction_id = txid_current())
$$;

CREATE FUNCTION public.p107_assert_epoch() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE current_epoch bigint; headers jsonb; requested text;
BEGIN
  -- The shared row lock is held until commit, before financial RPCs acquire
  -- business-row locks. Purge takes the conflicting lock and waits for them.
  SELECT epoch INTO current_epoch FROM public.retention_control WHERE id FOR SHARE;
  IF current_epoch = 0 OR auth.uid() IS NULL OR public.p107_is_executing() THEN RETURN; END IF;
  headers := COALESCE(NULLIF(current_setting('request.headers', true), ''), '{}')::jsonb;
  requested := headers->>'x-retention-epoch';
  IF requested IS DISTINCT FROM current_epoch::text THEN
    RAISE EXCEPTION 'RETENTION_EPOCH_CHANGED: Dữ liệu đã chuyển kỳ. Hãy tải lại ứng dụng trước khi tiếp tục.' USING ERRCODE='40001';
  END IF;
END $$;

CREATE FUNCTION public.rpc_retention_status() RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor public.profiles%ROWTYPE; result jsonb;
BEGIN
  SELECT * INTO actor FROM public.profiles WHERE auth_user_id=auth.uid() AND is_active;
  IF actor.id IS NULL THEN RAISE EXCEPTION '401: authentication required' USING ERRCODE='42501'; END IF;
  SELECT jsonb_build_object('available', true, 'epoch', epoch, 'cutoff', cutoff,
    'next_cutoff', public.p107_cutoff(), 'retained_months', 2) INTO result
  FROM public.retention_control WHERE id;
  IF actor.role='admin' THEN
    result := result || jsonb_build_object('last_job', (SELECT jsonb_build_object('id', id,
      'cutoff', cutoff, 'completed_at', j.completed_at, 'result', j.result)
      FROM public.retention_jobs j WHERE j.state='completed' ORDER BY j.completed_at DESC LIMIT 1));
  END IF;
  RETURN result;
END $$;

-- Enforce the epoch in every established RPC that uses the authentication
-- boundary, without exposing a second implementation that bypasses it.
DO $migration$
DECLARE original text;
BEGIN
  SELECT pg_get_functiondef('public.require_authenticated_profile()'::regprocedure) INTO original;
  IF original NOT LIKE '%RETURN actor;%' THEN RAISE EXCEPTION '0107: authentication boundary has drifted'; END IF;
  EXECUTE replace(original, 'RETURN actor;', 'PERFORM public.p107_assert_epoch(); RETURN actor;');
END $migration$;

CREATE FUNCTION public.p107_guard_document_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public AS $$
DECLARE boundary timestamptz; record_json jsonb; prior_json jsonb;
  effective timestamptz; prior_effective timestamptz; request_key text; actor_key text;
BEGIN
  IF public.p107_is_executing() THEN RETURN COALESCE(NEW, OLD); END IF;
  PERFORM public.p107_assert_epoch();
  SELECT cutoff INTO boundary FROM public.retention_control WHERE id;
  IF boundary IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  record_json := CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  prior_json := CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE record_json END;
  CASE TG_TABLE_NAME
    WHEN 'orders', 'draft_orders' THEN
      effective := COALESCE((record_json->>'order_date')::timestamptz, (record_json->>'created_at')::timestamptz);
      prior_effective := COALESCE((prior_json->>'order_date')::timestamptz, (prior_json->>'created_at')::timestamptz);
    WHEN 'cashbook_transactions' THEN
      effective := COALESCE((record_json->>'date')::timestamptz, (record_json->>'transaction_date')::timestamptz);
      prior_effective := COALESCE((prior_json->>'date')::timestamptz, (prior_json->>'transaction_date')::timestamptz);
    WHEN 'sales_returns' THEN
      effective := COALESCE((record_json->>'return_date')::timestamptz, (record_json->>'created_at')::timestamptz);
      prior_effective := COALESCE((prior_json->>'return_date')::timestamptz, (prior_json->>'created_at')::timestamptz);
    WHEN 'purchases' THEN
      effective := COALESCE((record_json->>'purchase_date')::timestamptz, (record_json->>'created_at')::timestamptz);
      prior_effective := COALESCE((prior_json->>'purchase_date')::timestamptz, (prior_json->>'created_at')::timestamptz);
    ELSE
      effective := COALESCE((record_json->>'transaction_date')::timestamptz, (record_json->>'created_at')::timestamptz);
      prior_effective := COALESCE((prior_json->>'transaction_date')::timestamptz, (prior_json->>'created_at')::timestamptz);
  END CASE;
  -- A retained document can own older immutable ledger rows after a date
  -- amendment. Existing rows are not rewritten merely to pass the cutoff.
  IF auth.uid() IS NOT NULL AND (effective < boundary OR prior_effective < boundary) THEN
    IF TG_TABLE_NAME <> 'customer_debt_transactions' OR TG_OP <> 'UPDATE' THEN
      RAISE EXCEPTION 'Kỳ trước % đã đóng. Hãy lập chứng từ điều chỉnh trong kỳ đang mở.', boundary USING ERRCODE='22023';
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    request_key := COALESCE(NULLIF(record_json->>'idempotency_key', ''),NULLIF(record_json->>'request_key',''));
    actor_key := COALESCE(record_json->>'created_by', record_json->>'performed_by', record_json->>'actor_id', auth.uid()::text, '');
    IF request_key IS NOT NULL AND EXISTS (SELECT 1 FROM public.retention_retired_requests
      WHERE digest=encode(sha256(convert_to(TG_TABLE_NAME || ':' || actor_key || ':' || request_key, 'UTF8')), 'hex')) THEN
      RAISE EXCEPTION 'Yêu cầu này thuộc chứng từ đã xóa và không được phát lại.' USING ERRCODE='23505';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;

DO $migration$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['orders','draft_orders','cashbook_transactions','payments','sales_returns',
    'customer_debt_transactions','purchases','purchase_payments','supplier_debt_transactions','order_amendments','inventory_documents'] LOOP
    EXECUTE format('CREATE TRIGGER p107_retention_write BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.p107_guard_document_write()',target);
  END LOOP;
END $migration$;

CREATE FUNCTION public.p107_guard_master_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF NOT public.p107_is_executing() THEN PERFORM public.p107_assert_epoch(); END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER p107_retention_master BEFORE INSERT OR UPDATE OR DELETE ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.p107_guard_master_write();
CREATE TRIGGER p107_retention_master BEFORE INSERT OR UPDATE OR DELETE ON public.suppliers
FOR EACH ROW EXECUTE FUNCTION public.p107_guard_master_write();
CREATE TRIGGER p107_retention_master BEFORE INSERT OR UPDATE OR DELETE ON public.starting_balances
FOR EACH ROW EXECUTE FUNCTION public.p107_guard_master_write();

CREATE FUNCTION public.p107_suppress_purge_payload() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF public.p107_is_executing() THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER a107_retention_log BEFORE INSERT ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.p107_suppress_purge_payload();
CREATE TRIGGER a107_retention_log BEFORE INSERT ON public.activity_logs
FOR EACH ROW EXECUTE FUNCTION public.p107_suppress_purge_payload();

-- The new authoritative opening is explicit: historical balance snapshots
-- remain immutable, but are no longer mistaken for a new statement opening.
CREATE OR REPLACE FUNCTION public.p74_customer_debt_ledger_balance(p_customer_id text)
RETURNS TABLE(ledger_count bigint, opening_balance numeric, debt_change_total numeric, calculated_balance numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH totals AS (SELECT count(*) AS n, round(COALESCE(sum(debt_change),0)) AS changes
    FROM public.customer_debt_transactions WHERE customer_id=p_customer_id), opening AS (
    SELECT round(COALESCE(balance_before,0)) AS value FROM public.customer_debt_transactions
    WHERE customer_id=p_customer_id ORDER BY COALESCE(created_at,transaction_date),id LIMIT 1
  ) SELECT totals.n, COALESCE(checkpoint.debt_opening, opening.value), totals.changes,
    CASE WHEN totals.n=0 AND checkpoint.customer_id IS NULL THEN NULL
      ELSE COALESCE(checkpoint.debt_opening,opening.value,0)+totals.changes END
  FROM totals LEFT JOIN opening ON true
  LEFT JOIN public.retention_customer_balances checkpoint ON checkpoint.customer_id=p_customer_id
$$;

-- Existing guards also have to validate checkpoint-only customers after a
-- complete history purge. Do not weaken the check when ledger_count is zero.
DO $migration$
DECLARE original text;
BEGIN
  SELECT pg_get_functiondef('public.p74_guard_customer_debt_invariant()'::regprocedure) INTO original;
  IF original NOT LIKE '%IF ledger_state.ledger_count > 0%' THEN RAISE EXCEPTION '0107: debt invariant has drifted'; END IF;
  EXECUTE replace(original, 'IF ledger_state.ledger_count > 0', 'IF ledger_state.calculated_balance IS NOT NULL');
END $migration$;

CREATE FUNCTION public.p107_cash_net(p_before timestamptz DEFAULT NULL) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH amounts AS (
    SELECT lower(COALESCE(NULLIF(method,''),NULLIF(payment_method,''),'cash')) method,
      CASE WHEN lower(COALESCE(type,''))='thu' OR lower(COALESCE(direction,''))='in' THEN COALESCE(value,0)
           WHEN lower(COALESCE(type,''))='chi' OR lower(COALESCE(direction,''))='out' THEN -COALESCE(value,0) ELSE 0 END amount
    FROM public.cashbook_transactions
    WHERE (p_before IS NULL OR COALESCE(date,transaction_date)<p_before)
      AND reversal_of_id IS NULL AND lower(COALESCE(transaction_type,'')) NOT LIKE '%reversal%'
      AND lower(COALESCE(id,'')) NOT LIKE 'void-%'
      AND lower(COALESCE(status,'')) NOT LIKE '%cancel%'
      AND lower(COALESCE(status,'')) NOT LIKE '%hủy%' AND lower(COALESCE(status,'')) NOT LIKE '%huy%'
      AND (lower(COALESCE(NULLIF(status,''),'đã thanh toán')) IN ('completed','paid')
        OR lower(COALESCE(NULLIF(status,''),'đã thanh toán')) LIKE '%thanh%')
  ) SELECT jsonb_build_object('cash',COALESCE(sum(amount) FILTER(WHERE method='cash'),0),
    'bank',COALESCE(sum(amount) FILTER(WHERE method='bank'),0), 'wallet',COALESCE(sum(amount) FILTER(WHERE method='wallet'),0)) FROM amounts
$$;

CREATE FUNCTION public.rpc_retention_cash_opening()
RETURNS TABLE(cash_carry numeric,bank_carry numeric,wallet_carry numeric,cutoff timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE;
BEGIN
  actor:=public.require_authenticated_profile();
  IF actor.role NOT IN('admin','accounting') THEN RAISE EXCEPTION 'Chỉ kế toán được xem số dư quỹ.' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT c.cash_carry,c.bank_carry,c.wallet_carry,c.cutoff FROM public.retention_control c WHERE c.id;
END $$;
REVOKE ALL ON FUNCTION public.rpc_retention_cash_opening() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_retention_cash_opening() TO authenticated;

DO $migration$
DECLARE original text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_get_cashbook_window(timestamptz,timestamptz)'::regprocedure) INTO original;
  IF original NOT LIKE '%FROM effective_before;%' THEN RAISE EXCEPTION '0107: cashbook window has drifted'; END IF;
  original := replace(original, 'FROM effective_before;', 'FROM effective_before;
    SELECT opening_cash+cash_carry, opening_bank+bank_carry, opening_wallet+wallet_carry
      INTO opening_cash,opening_bank,opening_wallet FROM public.rpc_retention_cash_opening();
    IF p_start < (SELECT cutoff FROM public.rpc_retention_cash_opening()) THEN
      RAISE EXCEPTION ''Kỳ sổ quỹ này đã xóa. Chỉ xem từ mốc còn lưu.'';
    END IF;');
  EXECUTE original;
END $migration$;

CREATE OR REPLACE FUNCTION public.p4_recompute_supplier(p_supplier_id text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE purchases_total numeric; paid_total numeric;
BEGIN
  SELECT COALESCE(sum(total_amount),0) INTO purchases_total FROM public.purchases WHERE supplier_id=p_supplier_id AND status='completed';
  SELECT COALESCE(sum(amount),0) INTO paid_total FROM public.purchase_payments WHERE supplier_id=p_supplier_id AND status='completed';
  SELECT purchases_total+COALESCE(c.purchase_carry,0), paid_total+COALESCE(c.paid_carry,0)
  INTO purchases_total,paid_total FROM (SELECT 1) seed LEFT JOIN public.retention_supplier_balances c ON c.supplier_id=p_supplier_id;
  UPDATE public.suppliers SET total_purchase=purchases_total,total_paid=paid_total,
    debt=opening_debt+purchases_total-paid_total,updated_at=now() WHERE id=p_supplier_id;
END $$;

-- Both preview and execution use this exact deterministic target plan.
CREATE FUNCTION public.p107_plan(p_cutoff timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  WITH old_orders AS (SELECT id FROM public.orders WHERE COALESCE(order_date,created_at)<p_cutoff),
  old_cashbook AS (SELECT id FROM public.cashbook_transactions WHERE COALESCE(date,transaction_date)<p_cutoff),
  old_returns AS (SELECT id FROM public.sales_returns WHERE COALESCE(return_date,created_at)<p_cutoff),
  old_purchases AS (SELECT id FROM public.purchases WHERE COALESCE(purchase_date,created_at)<p_cutoff),
  old_payments AS (SELECT id FROM public.payments WHERE cashbook_transaction_id IN (SELECT id FROM old_cashbook)
    OR (cashbook_transaction_id IS NULL AND created_at<p_cutoff)),
  old_supplier_payments AS (SELECT id FROM public.purchase_payments WHERE cashbook_transaction_id IN (SELECT id FROM old_cashbook)
    OR (cashbook_transaction_id IS NULL AND created_at<p_cutoff)),
  old_ledger AS (
    SELECT t.id FROM public.customer_debt_transactions t
    WHERE NOT EXISTS(SELECT 1 FROM public.orders o WHERE o.id=t.order_id AND o.id NOT IN(SELECT id FROM old_orders))
      AND NOT EXISTS(SELECT 1 FROM public.cashbook_transactions c WHERE c.id=t.cashbook_transaction_id AND c.id NOT IN(SELECT id FROM old_cashbook))
      AND NOT EXISTS(SELECT 1 FROM public.sales_returns r WHERE r.id=t.sales_return_id AND r.id NOT IN(SELECT id FROM old_returns))
      AND (t.order_id IN(SELECT id FROM old_orders) OR t.cashbook_transaction_id IN(SELECT id FROM old_cashbook)
        OR t.sales_return_id IN(SELECT id FROM old_returns) OR COALESCE(t.transaction_date,t.created_at)<p_cutoff)
  ) SELECT jsonb_build_object(
    'drafts',COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM public.draft_orders d
      WHERE COALESCE(NULLIF(to_jsonb(d)->>'order_date','')::timestamptz,d.created_at)<p_cutoff),'[]'::jsonb),
    'orders',COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM old_orders),'[]'::jsonb),
    'cashbook',COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM old_cashbook),'[]'::jsonb),
    'returns',COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM old_returns),'[]'::jsonb),
    'purchases',COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM old_purchases),'[]'::jsonb),
    'payments',COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM old_payments),'[]'::jsonb),
    'supplier_payments',COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM old_supplier_payments),'[]'::jsonb),
    'ledger',COALESCE((SELECT jsonb_agg(id ORDER BY id) FROM old_ledger),'[]'::jsonb))
$$;

CREATE FUNCTION public.p107_snapshot_tables(p_include_archive boolean) RETURNS text[]
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT array_agg(name ORDER BY ordinal) FROM unnest(ARRAY[
    'companies','brands','product_groups','payroll_product_groups','products','profiles','pricelists','price_list_items',
    'customers','suppliers','orders','draft_orders','order_items','sales_returns','sales_return_items',
    'cashbook_transactions','payments','customer_debt_transactions','order_amendments',
    'customer_debt_amendment_voids','customer_debt_history_suppressions','purchases','purchase_items',
    'purchase_payments','supplier_debt_transactions','commission_transactions','payroll_periods',
    'payroll_entries','payroll_adjustments','starting_balances','inventory_control','inventory_balances','inventory_documents','inventory_movements',
    'inventory_order_positions','inventory_pending_orders','inventory_sync_outbox',
    'bom_items','bom_item_balances','bom_item_documents','bom_versions','bom_lines','bom_runs','bom_item_movements',
    'audit_logs','activity_logs',
    'retention_control','retention_customer_balances','retention_customer_company_balances','retention_supplier_balances','retention_inventory_balances',
    'retention_retired_requests','activity_logs_archive_pre_20260804'
  ]) WITH ORDINALITY t(name,ordinal)
  WHERE to_regclass('public.'||name) IS NOT NULL
    AND (name<>'activity_logs_archive_pre_20260804' OR p_include_archive)
$$;

CREATE FUNCTION public.p107_fingerprint(p_include_archive boolean) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target text; part text; pieces text := '';
BEGIN
  FOREACH target IN ARRAY public.p107_snapshot_tables(p_include_archive) LOOP
    EXECUTE format('SELECT encode(sha256(convert_to(COALESCE(string_agg(row_hash,'''' ORDER BY row_hash),''''),''UTF8'')),''hex'')
      FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,''UTF8'')),''hex'') row_hash FROM public.%I t) hashed',target) INTO part;
    pieces := pieces || target || ':' || part || ';';
  END LOOP;
  RETURN encode(sha256(convert_to(pieces,'UTF8')),'hex');
END $$;

CREATE FUNCTION public.p107_trigger_fingerprint() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT encode(sha256(convert_to(COALESCE(string_agg(pg_get_triggerdef(t.oid)||':'||pg_get_functiondef(t.tgfoid),
    E'\n' ORDER BY c.relname,t.tgname),''),'UTF8')),'hex')
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname=ANY(public.p107_snapshot_tables(true))
$$;

CREATE FUNCTION public.p107_preview(p_include_archive boolean) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE plan jsonb; counts jsonb; boundary timestamptz := public.p107_cutoff(); blockers jsonb := '[]';
  n bigint; state public.retention_control%ROWTYPE;
BEGIN
  SELECT * INTO state FROM public.retention_control WHERE id;
  IF state.expected_trigger_hash IS DISTINCT FROM public.p107_trigger_fingerprint() THEN
    blockers:=blockers||jsonb_build_array('Trigger hoặc mã xử lý dữ liệu đã thay đổi sau khi cài đặt; cần rà soát lại trước khi dọn.');
  END IF;
  plan := public.p107_plan(boundary);
  SELECT jsonb_object_agg(key,jsonb_array_length(value)) INTO counts FROM jsonb_each(plan);
  IF state.cutoff IS NOT NULL AND boundary<=state.cutoff THEN blockers:=blockers||jsonb_build_array('Kỳ này đã được dọn.'); END IF;
  SELECT count(*) INTO n FROM public.customers c CROSS JOIN LATERAL public.p74_customer_debt_ledger_balance(c.id) b
  WHERE b.calculated_balance IS NOT NULL AND round(COALESCE(c.debt,0)) IS DISTINCT FROM b.calculated_balance;
  IF n>0 THEN blockers:=blockers||jsonb_build_array(format('Có %s khách đang lệch công nợ; phải đối soát trước.',n)); END IF;
  SELECT count(*) INTO n FROM public.customer_debt_transactions
  WHERE balance_before IS NULL OR balance_after IS NULL OR debt_change IS NULL OR round(balance_after)<>round(balance_before+debt_change);
  IF n>0 THEN blockers:=blockers||jsonb_build_array('Có bút toán sai phép tính; phải đối soát trước.'); END IF;
  IF EXISTS(SELECT 1 FROM public.customers WHERE COALESCE(jsonb_typeof(debt_history),'null') NOT IN('array','null')) THEN
    blockers:=blockers||jsonb_build_array('Lịch sử công nợ nhúng trong hồ sơ khách không đúng định dạng; cần xử lý trước để không sót bản sao.');
  END IF;
  IF EXISTS(SELECT 1 FROM public.orders WHERE COALESCE(order_date,created_at) IS NULL)
    OR EXISTS(SELECT 1 FROM public.draft_orders d WHERE COALESCE(NULLIF(to_jsonb(d)->>'order_date','')::timestamptz,d.created_at) IS NULL)
    OR EXISTS(SELECT 1 FROM public.cashbook_transactions WHERE COALESCE(date,transaction_date) IS NULL)
    OR EXISTS(SELECT 1 FROM public.sales_returns WHERE COALESCE(return_date,created_at) IS NULL)
    OR EXISTS(SELECT 1 FROM public.purchases WHERE COALESCE(purchase_date,created_at) IS NULL)
    OR EXISTS(SELECT 1 FROM public.customer_debt_transactions WHERE COALESCE(transaction_date,created_at) IS NULL) THEN
    blockers:=blockers||jsonb_build_array('Có chứng từ thiếu ngày nghiệp vụ/ngày tạo; cần xác định kỳ trước khi dọn.');
  END IF;
  IF EXISTS(SELECT 1 FROM public.suppliers s WHERE round(s.debt) IS DISTINCT FROM round(s.opening_debt+s.total_purchase-s.total_paid)) THEN
    blockers:=blockers||jsonb_build_array('Số cuối cùng nhà cung cấp chưa khớp nợ đầu kỳ + tổng mua - tổng đã trả; cần đối soát trước.');
  END IF;
  IF EXISTS(SELECT 1 FROM public.suppliers s WHERE s.total_purchase<COALESCE((SELECT sum(p.total_amount) FROM public.purchases p
      WHERE p.supplier_id=s.id AND p.status='completed' AND p.id NOT IN(SELECT jsonb_array_elements_text(plan->'purchases'))),0)
    OR s.total_paid<COALESCE((SELECT sum(p.amount) FROM public.purchase_payments p WHERE p.supplier_id=s.id AND p.status='completed'
      AND p.id NOT IN(SELECT jsonb_array_elements_text(plan->'supplier_payments'))),0)) THEN
    blockers:=blockers||jsonb_build_array('Tổng mua/đã trả NCC nhỏ hơn chứng từ còn giữ; cần đối soát trước.');
  END IF;
  IF to_regclass('public.inventory_sync_outbox') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.inventory_sync_outbox WHERE pending AND order_id IN (SELECT jsonb_array_elements_text($1))'
      INTO n USING plan->'orders';
    IF n>0 THEN blockers:=blockers||jsonb_build_array(format('Còn %s đơn cũ chờ đồng bộ kho ngoài.',n)); END IF;
  END IF;
  SELECT count(*) INTO n FROM public.inventory_pending_orders WHERE order_id IN(SELECT jsonb_array_elements_text(plan->'orders'));
  IF n>0 THEN blockers:=blockers||jsonb_build_array(format('Còn %s đơn cũ chờ đồng bộ kho tích hợp.',n)); END IF;
  SELECT count(*) INTO n FROM public.sales_returns r WHERE COALESCE(r.order_id,r.sale_id) IN(SELECT jsonb_array_elements_text(plan->'orders'))
    AND r.id NOT IN(SELECT jsonb_array_elements_text(plan->'returns'))
    AND COALESCE(r.refund_amount,0)<>0
    AND (r.refund_cashbook_transaction_id IS NULL OR r.refund_cashbook_transaction_id IN(SELECT jsonb_array_elements_text(plan->'cashbook')));
  IF n>0 THEN blockers:=blockers||jsonb_build_array('Phiếu trả còn lưu có hoàn tiền nhưng chứng từ hoàn tiền sẽ bị xóa; cần đối soát trước.'); END IF;
  IF EXISTS(SELECT 1 FROM public.inventory_control WHERE activated_at IS NOT NULL) AND EXISTS(
    SELECT 1 FROM public.sales_returns r WHERE COALESCE(r.order_id,r.sale_id) IN(SELECT jsonb_array_elements_text(plan->'orders'))
      AND r.id NOT IN(SELECT jsonb_array_elements_text(plan->'returns'))) THEN
    blockers:=blockers||jsonb_build_array('Phiếu trả qua kỳ có kho đang hoạt động cần đối soát tồn trước khi tách đơn.');
  END IF;
  -- Do not silently reclassify an order-linked receipt. Its cancellation and
  -- payment amendment semantics need explicit review before severing the link.
  IF EXISTS(SELECT 1 FROM public.cashbook_transactions c WHERE c.order_id IN(SELECT jsonb_array_elements_text(plan->'orders'))
    AND c.id NOT IN(SELECT jsonb_array_elements_text(plan->'cashbook')) AND c.sales_return_id IS NULL)
    OR EXISTS(SELECT 1 FROM public.payments p WHERE p.order_id IN(SELECT jsonb_array_elements_text(plan->'orders'))
      AND p.id NOT IN(SELECT jsonb_array_elements_text(plan->'payments'))) THEN
    blockers:=blockers||jsonb_build_array('Có phiếu thanh toán còn lưu liên quan đơn cũ; cần đối soát trước khi tách.');
  END IF;
  IF EXISTS(SELECT 1 FROM public.payments p WHERE p.id IN(SELECT jsonb_array_elements_text(plan->'payments'))
    AND p.order_id IS NOT NULL AND p.order_id NOT IN(SELECT jsonb_array_elements_text(plan->'orders')))
    OR EXISTS(SELECT 1 FROM public.purchase_payments p WHERE p.id IN(SELECT jsonb_array_elements_text(plan->'supplier_payments'))
      AND p.purchase_id IS NOT NULL AND p.purchase_id NOT IN(SELECT jsonb_array_elements_text(plan->'purchases'))) THEN
    blockers:=blockers||jsonb_build_array('Đơn còn lưu có thanh toán thuộc kỳ xóa; cần đối soát trước.');
  END IF;
  IF EXISTS(SELECT 1 FROM public.cashbook_transactions c WHERE c.sales_return_id IN(SELECT jsonb_array_elements_text(plan->'returns'))
    AND c.id NOT IN(SELECT jsonb_array_elements_text(plan->'cashbook'))) THEN
    blockers:=blockers||jsonb_build_array('Chứng từ quỹ còn lưu liên quan phiếu trả thuộc kỳ xóa; cần đối soát trước.');
  END IF;
  IF EXISTS(SELECT 1 FROM public.commission_transactions c WHERE c.salary_period>=to_char(boundary AT TIME ZONE 'Asia/Bangkok','YYYY-MM')
    AND (c.order_id IN(SELECT jsonb_array_elements_text(plan->'orders')) OR c.sales_return_id IN(SELECT jsonb_array_elements_text(plan->'returns')))) THEN
    blockers:=blockers||jsonb_build_array('Hoa hồng kỳ còn lưu liên quan chứng từ cũ; cần chốt và đối soát trước.');
  END IF;
  SELECT count(*) INTO n FROM pg_constraint fk JOIN pg_class parent ON parent.oid=fk.confrelid
    JOIN pg_namespace ns ON ns.oid=parent.relnamespace
    WHERE fk.contype='f' AND ns.nspname='public'
      AND parent.relname=ANY(ARRAY['orders','cashbook_transactions','customer_debt_transactions','sales_returns','purchases','purchase_payments','order_amendments'])
      AND NOT (fk.conrelid::regclass::text=ANY(public.p107_snapshot_tables(true))
        OR replace(fk.conrelid::regclass::text,'public.','')=ANY(public.p107_snapshot_tables(true)));
  IF n>0 THEN blockers:=blockers||jsonb_build_array('Schema có liên kết mới chưa được hỗ trợ; cần cập nhật trước khi dọn.'); END IF;
  IF p_include_archive AND to_regclass('public.activity_logs_archive_pre_20260804') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.activity_logs_archive_pre_20260804 WHERE created_at IS NULL OR created_at >= $1' INTO n USING boundary;
    IF n>0 THEN blockers:=blockers||jsonb_build_array('Bảng nhật ký lưu trữ có dữ liệu thuộc hai tháng còn giữ.'); END IF;
    IF EXISTS(SELECT 1 FROM pg_constraint WHERE contype='f' AND confrelid='public.activity_logs_archive_pre_20260804'::regclass)
      OR EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.activity_logs_archive_pre_20260804'::regclass AND NOT tgisinternal)
      OR EXISTS(SELECT 1 FROM pg_depend WHERE refobjid='public.activity_logs_archive_pre_20260804'::regclass AND deptype='n') THEN
      blockers:=blockers||jsonb_build_array('Bảng archive có liên kết/trigger mới; cần kiểm tra trước khi dọn.');
    END IF;
    EXECUTE 'SELECT count(*) FROM public.activity_logs_archive_pre_20260804' INTO n;
    counts:=counts||jsonb_build_object('legacy_archive',n);
  END IF;
  RETURN jsonb_build_object('cutoff',boundary,'epoch',state.epoch,'counts',counts,'blockers',blockers,
    'can_prepare',jsonb_array_length(blockers)=0,'include_archive',p_include_archive,
    'database_bytes',pg_database_size(current_database()),'snapshot_at',now());
END $$;

CREATE FUNCTION public.rpc_preview_monthly_retention(p_include_archive boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.p107_require_admin();
  RETURN public.p107_preview(p_include_archive);
END $$;

CREATE FUNCTION public.p107_lock_scope(p_include_archive boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target text;
BEGIN
  PERFORM 1 FROM public.retention_control WHERE id FOR UPDATE;
  FOREACH target IN ARRAY public.p107_snapshot_tables(p_include_archive) LOOP
    EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE',target);
  END LOOP;
END $$;

CREATE FUNCTION public.rpc_prepare_monthly_retention(p_request_key uuid, p_include_archive boolean DEFAULT true) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; preview jsonb; snapshot jsonb:='{}'; columns_map jsonb:='{}';
  target text; rows_data jsonb; columns_data jsonb; fingerprint text; payload jsonb; backup_text text;
  sequence_entry record; sequence_data jsonb; sequences_map jsonb:='{}';
  job public.retention_jobs%ROWTYPE; boundary timestamptz:=public.p107_cutoff();
BEGIN
  actor:=public.p107_require_admin();
  IF p_request_key IS NULL THEN RAISE EXCEPTION 'Thiếu mã yêu cầu.'; END IF;
  PERFORM set_config('lock_timeout','3s',true);
  IF NOT EXISTS(SELECT 1 FROM public.system_maintenance WHERE id AND enabled) THEN
    RAISE EXCEPTION 'Hãy bật bảo trì trước khi tạo bản sao phục hồi và dọn dữ liệu.';
  END IF;
  PERFORM public.p107_lock_scope(p_include_archive);
  SELECT * INTO job FROM public.retention_jobs WHERE id=p_request_key FOR UPDATE;
  IF FOUND AND (job.actor_id<>actor.auth_user_id OR job.include_archive<>p_include_archive OR job.cutoff<>boundary) THEN
    RAISE EXCEPTION 'Mã yêu cầu đã dùng cho lần dọn khác.';
  END IF;
  IF job.state='completed' THEN RETURN jsonb_build_object('job_id',job.id,'state','completed','result',job.result); END IF;
  preview:=public.p107_preview(p_include_archive);
  IF NOT (preview->>'can_prepare')::boolean THEN RAISE EXCEPTION 'Chưa thể dọn: %',preview->'blockers'; END IF;
  fingerprint:=public.p107_fingerprint(p_include_archive);
  IF job.id IS NOT NULL AND (job.fingerprint<>fingerprint OR job.expires_at<now()) THEN
    RAISE EXCEPTION 'Bản xem trước đã cũ. Hãy tạo lần dọn mới và sao lưu lại.';
  END IF;
  FOREACH target IN ARRAY public.p107_snapshot_tables(p_include_archive) LOOP
    EXECUTE format('SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY md5(to_jsonb(t)::text)),''[]''::jsonb) FROM public.%I t',target) INTO rows_data;
    SELECT jsonb_agg(column_name ORDER BY ordinal_position) INTO columns_data FROM information_schema.columns
      WHERE table_schema='public' AND table_name=target;
    snapshot:=snapshot||jsonb_build_object(target,rows_data);
    columns_map:=columns_map||jsonb_build_object(target,columns_data);
  END LOOP;
  FOR sequence_entry IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename LOOP
    EXECUTE format('SELECT jsonb_build_object(''last_value'',last_value,''is_called'',is_called) FROM public.%I',sequence_entry.sequencename) INTO sequence_data;
    sequences_map:=sequences_map||jsonb_build_object(sequence_entry.sequencename,sequence_data);
  END LOOP;
  payload:=jsonb_build_object('format','soviet-retention-recovery-v1','job_id',p_request_key,
    'created_at',COALESCE(job.created_at,now()),'cutoff',boundary,'epoch',preview->'epoch',
    'fingerprint',fingerprint,'schema_versions',(SELECT jsonb_agg(version ORDER BY version) FROM public.schema_migrations),
    'columns',columns_map,'tables',snapshot,'sequences',sequences_map,
    'scope','Application recovery bundle. Auth users, secrets and project configuration are not included. Restore only into isolated staging with matching schema.');
  backup_text:=payload::text;
  INSERT INTO public.retention_jobs(id,actor_id,cutoff,include_archive,epoch_before,state,fingerprint,backup_sha256,preview,expires_at)
  VALUES(p_request_key,actor.auth_user_id,boundary,p_include_archive,(preview->>'epoch')::bigint,'prepared',fingerprint,
    encode(sha256(convert_to(backup_text,'UTF8')),'hex'),preview,now()+interval '30 minutes')
  ON CONFLICT(id) DO NOTHING RETURNING * INTO job;
  IF job.id IS NULL THEN SELECT * INTO STRICT job FROM public.retention_jobs WHERE id=p_request_key; END IF;
  PERFORM set_config('response.headers','[{"Cache-Control":"no-store"}]',true);
  RETURN jsonb_build_object('job_id',job.id,'state',job.state,'preview',job.preview,
    'backup_text',backup_text,'backup_sha256',job.backup_sha256,'expires_at',job.expires_at);
END $$;

-- Execution is defined below in the same migration. A missing definition is
-- never interpreted by the client as permission to use legacy DELETE calls.

-- Compact audit payloads still contain debt_history because their field
-- whitelist matches "debt". Remove those duplicate statement arrays even in
-- recent customer-edit logs, and inspect nested source IDs before retaining a log.
CREATE FUNCTION public.p107_scrub_history_json(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,public AS $$
BEGIN
  IF jsonb_typeof(payload)='object' THEN
    RETURN COALESCE((SELECT jsonb_object_agg(key,public.p107_scrub_history_json(value)) FROM jsonb_each(payload)
      WHERE lower(replace(key,'_',''))<>'debthistory'),'{}'::jsonb);
  ELSIF jsonb_typeof(payload)='array' THEN
    RETURN COALESCE((SELECT jsonb_agg(public.p107_scrub_history_json(value) ORDER BY ordinal)
      FROM jsonb_array_elements(payload) WITH ORDINALITY items(value,ordinal)),'[]'::jsonb);
  END IF;
  RETURN payload;
END $$;

CREATE FUNCTION public.p107_payload_references_removed(payload jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE item jsonb;
BEGIN
  IF jsonb_typeof(payload)='object' THEN
    FOR item IN SELECT value FROM jsonb_each(payload) LOOP
      IF public.p107_payload_references_removed(item) THEN RETURN true; END IF;
    END LOOP;
  ELSIF jsonb_typeof(payload)='array' THEN
    FOR item IN SELECT value FROM jsonb_array_elements(payload) LOOP
      IF public.p107_payload_references_removed(item) THEN RETURN true; END IF;
    END LOOP;
  ELSIF jsonb_typeof(payload)='string' THEN
    RETURN EXISTS(SELECT 1 FROM pg_temp._retention_ids WHERE id=payload#>>'{}');
  END IF;
  RETURN false;
END $$;

CREATE FUNCTION public.rpc_retention_job(p_job_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE;
BEGIN
  actor:=public.p107_require_admin();
  RETURN (SELECT jsonb_build_object('job_id',id,'state',state,'cutoff',cutoff,'backup_sha256',backup_sha256,
    'preview',preview,'result',result,'expires_at',expires_at,'completed_at',completed_at)
    FROM public.retention_jobs WHERE id=p_job_id AND actor_id=actor.auth_user_id);
END $$;

CREATE FUNCTION public.rpc_execute_monthly_retention(p_job_id uuid, p_backup_sha256 text, p_confirmation text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; job public.retention_jobs%ROWTYPE; plan jsonb; preview jsonb;
  target text; deleted_rows bigint; counts jsonb:='{}'; before_cash jsonb; after_cash jsonb;
  old_control public.retention_control%ROWTYPE; removed_cash jsonb; epoch_after bigint; result_payload jsonb;
BEGIN
  actor:=public.p107_require_admin();
  PERFORM set_config('lock_timeout','3s',true);
  -- Same lock order as backup preparation; a retry after a lost response
  -- returns the committed result rather than executing a second deletion.
  PERFORM 1 FROM public.retention_control WHERE id FOR UPDATE;
  SELECT * INTO STRICT job FROM public.retention_jobs WHERE id=p_job_id AND actor_id=actor.auth_user_id FOR UPDATE;
  IF job.state='completed' THEN RETURN job.result||jsonb_build_object('already_completed',true); END IF;
  IF job.state<>'prepared' OR job.expires_at<now() OR job.cutoff<>public.p107_cutoff()
    OR job.backup_sha256 IS DISTINCT FROM p_backup_sha256
    OR p_confirmation IS DISTINCT FROM ('XOA TRUOC '||to_char(job.cutoff AT TIME ZONE 'Asia/Bangkok','DD/MM/YYYY')) THEN
    RAISE EXCEPTION 'Xác nhận, bản sao phục hồi hoặc thời hạn lần dọn không hợp lệ.';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.system_maintenance WHERE id AND enabled) THEN
    RAISE EXCEPTION 'Chỉ được dọn khi đang bật bảo trì.';
  END IF;
  PERFORM public.p107_lock_scope(job.include_archive);
  SELECT * INTO old_control FROM public.retention_control WHERE id;
  IF old_control.epoch<>job.epoch_before OR public.p107_fingerprint(job.include_archive)<>job.fingerprint THEN
    RAISE EXCEPTION 'Dữ liệu đã thay đổi sau khi sao lưu. Chưa xóa gì; hãy tạo bản sao mới.' USING ERRCODE='40001';
  END IF;
  preview:=public.p107_preview(job.include_archive);
  IF NOT (preview->>'can_prepare')::boolean THEN RAISE EXCEPTION 'Chưa thể dọn: %',preview->'blockers'; END IF;
  plan:=public.p107_plan(job.cutoff);
  UPDATE public.retention_jobs SET state='executing',backend_pid=pg_backend_pid(),transaction_id=txid_current() WHERE id=job.id;
  PERFORM set_config('app.retention_job',job.id::text,true);

  CREATE TEMP TABLE _retention_ids(kind text,id text,PRIMARY KEY(kind,id)) ON COMMIT DROP;
  INSERT INTO _retention_ids SELECT entry.key,ids.id FROM jsonb_each(plan) entry
    CROSS JOIN LATERAL jsonb_array_elements_text(entry.value) ids(id);
  INSERT INTO _retention_ids SELECT 'order_items',id FROM public.order_items WHERE order_id IN(SELECT id FROM _retention_ids WHERE kind='orders');
  INSERT INTO _retention_ids SELECT 'return_items',id FROM public.sales_return_items WHERE return_id IN(SELECT id FROM _retention_ids WHERE kind='returns');
  INSERT INTO _retention_ids SELECT 'amendments',id FROM public.order_amendments WHERE order_id IN(SELECT id FROM _retention_ids WHERE kind='orders');
  INSERT INTO _retention_ids SELECT 'converted_returns',id FROM public.sales_returns
    WHERE COALESCE(order_id,sale_id) IN(SELECT id FROM _retention_ids WHERE kind='orders')
      AND id NOT IN(SELECT id FROM _retention_ids WHERE kind='returns');

  -- Snapshot every master field, not only SUM(debt). Customer contact details,
  -- last transaction times, imported baselines and lifetime sales stay exact.
  CREATE TEMP TABLE _retention_preserved(kind text,id text,payload jsonb,PRIMARY KEY(kind,id)) ON COMMIT DROP;
  INSERT INTO _retention_preserved SELECT 'customers',id,to_jsonb(c)-'debt_history' FROM public.customers c;
  INSERT INTO _retention_preserved SELECT 'suppliers',id,to_jsonb(s) FROM public.suppliers s;
  INSERT INTO _retention_preserved SELECT 'stock',product_id,to_jsonb(s) FROM public.inventory_balances s;
  INSERT INTO _retention_preserved SELECT 'starting_balances',id,to_jsonb(s) FROM public.starting_balances s;
  CREATE TEMP TABLE _retention_openings ON COMMIT DROP AS
    SELECT c.id AS customer_id, COALESCE(b.opening_balance,c.debt,0)+COALESCE((
      SELECT sum(t.debt_change) FROM public.customer_debt_transactions t
      WHERE t.customer_id=c.id AND t.id IN(SELECT id FROM _retention_ids WHERE kind='ledger')),0) AS opening,
      COALESCE(checkpoint.payment_carry,0)+COALESCE((SELECT sum(-t.debt_change)
        FROM public.customer_debt_transactions t WHERE t.customer_id=c.id
          AND t.id IN(SELECT id FROM _retention_ids WHERE kind='ledger')
          AND (t.transaction_type IN('payment','payment_cancel','payment_amend','payment_relink')
            OR (t.transaction_type='adjust' AND lower(COALESCE(t.description,'')) LIKE '%hủy phiếu thu%'))),0) AS payment_carry
    FROM public.customers c CROSS JOIN LATERAL public.p74_customer_debt_ledger_balance(c.id) b
    LEFT JOIN public.retention_customer_balances checkpoint ON checkpoint.customer_id=c.id;
  IF EXISTS(SELECT 1 FROM _retention_openings WHERE payment_carry<0) THEN
    RAISE EXCEPTION 'Lịch sử thu tiền có số chuyển kỳ âm; cần đối soát trước.';
  END IF;
  before_cash:=public.p107_cash_net(NULL);
  -- Preserve the existing company-report attribution separately from the full
  -- customer balance. Unallocated opening debt/receipts are never invented as
  -- a company allocation. Retained adjustments keep their original company.
  INSERT INTO public.retention_customer_company_balances(customer_id,company_id,debt_opening,cutoff)
    SELECT t.customer_id,COALESCE(t.retention_company_id,o.company_id),sum(t.debt_change),job.cutoff
    FROM public.customer_debt_transactions t LEFT JOIN public.orders o ON o.id=t.order_id
    WHERE t.id IN(SELECT id FROM _retention_ids WHERE kind='ledger')
      AND NULLIF(COALESCE(t.retention_company_id,o.company_id),'') IS NOT NULL
    GROUP BY t.customer_id,COALESCE(t.retention_company_id,o.company_id)
    ON CONFLICT(customer_id,company_id) DO UPDATE
      SET debt_opening=retention_customer_company_balances.debt_opening+EXCLUDED.debt_opening,cutoff=EXCLUDED.cutoff;
  UPDATE public.customer_debt_transactions t SET retention_company_id=COALESCE(t.retention_company_id,o.company_id)
    FROM public.orders o WHERE t.order_id=o.id AND o.id IN(SELECT id FROM _retention_ids WHERE kind='orders')
      AND t.id NOT IN(SELECT id FROM _retention_ids WHERE kind='ledger');
  -- Compute the removed effective cash with the exact established semantics.
  CREATE TEMP TABLE _retention_cash_rows ON COMMIT DROP AS
    SELECT * FROM public.cashbook_transactions WHERE id IN(SELECT id FROM _retention_ids WHERE kind='cashbook');

  -- Tombstones contain only keyed request digests, never old document bodies.
  FOREACH target IN ARRAY ARRAY['orders','cashbook_transactions','payments','sales_returns','order_amendments','purchase_payments','purchases'] LOOP
    EXECUTE format('INSERT INTO public.retention_retired_requests(digest)
      SELECT encode(sha256(convert_to($1||'':''||COALESCE(to_jsonb(t)->>''created_by'',to_jsonb(t)->>''performed_by'','''')||'':''||(to_jsonb(t)->>''idempotency_key''),''UTF8'')),''hex'')
      FROM public.%I t WHERE NULLIF(to_jsonb(t)->>''idempotency_key'','''') IS NOT NULL AND t.id IN
      (SELECT id FROM _retention_ids WHERE kind=$2) ON CONFLICT DO NOTHING',target)
      USING target,CASE target WHEN 'cashbook_transactions' THEN 'cashbook' WHEN 'sales_returns' THEN 'returns'
        WHEN 'order_amendments' THEN 'amendments' WHEN 'purchase_payments' THEN 'supplier_payments' ELSE target END;
  END LOOP;

  -- Save independent reporting attribution before removing the parent order.
  UPDATE public.sales_return_items item SET
    revenue_brand_id=COALESCE(item.revenue_brand_id,source.brand_id),
    revenue_company_id=COALESCE(item.revenue_company_id,brand.company_id,sale.company_id)
  FROM public.order_items source JOIN public.orders sale ON sale.id=source.order_id
  LEFT JOIN public.brands brand ON brand.id=source.brand_id OR brand.name=source.brand_id
  WHERE item.sale_item_id=source.id AND item.return_id IN(SELECT id FROM _retention_ids WHERE kind='converted_returns');
  UPDATE public.sales_returns ret SET company_id=COALESCE(ret.company_id,sale.company_id)
  FROM public.orders sale WHERE sale.id=COALESCE(ret.order_id,ret.sale_id)
    AND ret.id IN(SELECT id FROM _retention_ids WHERE kind='converted_returns');
  UPDATE public.sales_return_items SET sale_item_id=NULL
    WHERE return_id IN(SELECT id FROM _retention_ids WHERE kind='converted_returns');
  UPDATE public.sales_returns SET source_kind='independent',sale_id=NULL,order_id=NULL
    WHERE id IN(SELECT id FROM _retention_ids WHERE kind='converted_returns');
  UPDATE public.cashbook_transactions SET order_id=NULL WHERE sales_return_id IN(SELECT id FROM _retention_ids WHERE kind='converted_returns');
  -- Current adjustments to an old source remain true current movements, not
  -- a replacement sale. Removing source pointers must not change their delta.
  UPDATE public.customer_debt_transactions SET
    order_id=CASE WHEN order_id IN(SELECT id FROM _retention_ids WHERE kind='orders') THEN NULL ELSE order_id END,
    cashbook_transaction_id=CASE WHEN cashbook_transaction_id IN(SELECT id FROM _retention_ids WHERE kind='cashbook') THEN NULL ELSE cashbook_transaction_id END,
    sales_return_id=CASE WHEN sales_return_id IN(SELECT id FROM _retention_ids WHERE kind='returns') THEN NULL ELSE sales_return_id END,
    reversal_of_id=CASE WHEN reversal_of_id IN(SELECT id FROM _retention_ids WHERE kind='ledger') THEN NULL ELSE reversal_of_id END,
    amends_ledger_id=CASE WHEN amends_ledger_id IN(SELECT id FROM _retention_ids WHERE kind='ledger') THEN NULL ELSE amends_ledger_id END,
    transaction_type=CASE WHEN order_id IN(SELECT id FROM _retention_ids WHERE kind='orders')
      AND sales_return_id IS NULL AND cashbook_transaction_id IS NULL THEN 'adjust' ELSE transaction_type END,
    description=CASE WHEN order_id IN(SELECT id FROM _retention_ids WHERE kind='orders') THEN 'Phát sinh điều chỉnh trong kỳ còn lưu'
      ELSE description END
  WHERE id NOT IN(SELECT id FROM _retention_ids WHERE kind='ledger') AND
    (order_id IN(SELECT id FROM _retention_ids WHERE kind='orders') OR cashbook_transaction_id IN(SELECT id FROM _retention_ids WHERE kind='cashbook')
      OR sales_return_id IN(SELECT id FROM _retention_ids WHERE kind='returns') OR reversal_of_id IN(SELECT id FROM _retention_ids WHERE kind='ledger')
      OR amends_ledger_id IN(SELECT id FROM _retention_ids WHERE kind='ledger'));
  DELETE FROM public.customer_debt_amendment_voids WHERE ledger_id IN(SELECT id FROM _retention_ids WHERE kind='ledger')
    OR target_amendment_id IN(SELECT id FROM _retention_ids WHERE kind='amendments')
    OR reversal_amendment_id IN(SELECT id FROM _retention_ids WHERE kind='amendments');
  DELETE FROM public.customer_debt_history_suppressions WHERE ledger_id IN(SELECT id FROM _retention_ids WHERE kind='ledger');
  DELETE FROM public.order_amendments WHERE id IN(SELECT id FROM _retention_ids WHERE kind='amendments');
  DELETE FROM public.customer_debt_transactions WHERE id IN(SELECT id FROM _retention_ids WHERE kind='ledger');
  DELETE FROM public.payments WHERE id IN(SELECT id FROM _retention_ids WHERE kind='payments');
  UPDATE public.cashbook_transactions SET reversal_of_id=NULL WHERE id NOT IN(SELECT id FROM _retention_ids WHERE kind='cashbook')
    AND reversal_of_id IN(SELECT id FROM _retention_ids WHERE kind='cashbook');
  DELETE FROM public.sales_return_items WHERE return_id IN(SELECT id FROM _retention_ids WHERE kind='returns');
  DELETE FROM public.sales_returns WHERE id IN(SELECT id FROM _retention_ids WHERE kind='returns');

  INSERT INTO public.retention_supplier_balances(supplier_id,purchase_carry,paid_carry,cutoff)
  SELECT s.id,s.total_purchase-COALESCE((SELECT sum(total_amount) FROM public.purchases
    WHERE supplier_id=s.id AND status='completed' AND id NOT IN(SELECT id FROM _retention_ids WHERE kind='purchases')),0),
    s.total_paid-COALESCE((SELECT sum(amount) FROM public.purchase_payments
    WHERE supplier_id=s.id AND status='completed' AND id NOT IN(SELECT id FROM _retention_ids WHERE kind='supplier_payments')),0),job.cutoff
  FROM public.suppliers s
  ON CONFLICT(supplier_id) DO UPDATE SET purchase_carry=EXCLUDED.purchase_carry,paid_carry=EXCLUDED.paid_carry,cutoff=EXCLUDED.cutoff;
  UPDATE public.purchase_payments SET purchase_id=NULL
    WHERE purchase_id IN(SELECT id FROM _retention_ids WHERE kind='purchases')
      AND id NOT IN(SELECT id FROM _retention_ids WHERE kind='supplier_payments');
  DELETE FROM public.supplier_debt_transactions WHERE payment_id IN(SELECT id FROM _retention_ids WHERE kind='supplier_payments')
    OR (transaction_date<job.cutoff AND (purchase_id IS NULL OR purchase_id IN(SELECT id FROM _retention_ids WHERE kind='purchases')));
  UPDATE public.supplier_debt_transactions SET purchase_id=NULL WHERE purchase_id IN(SELECT id FROM _retention_ids WHERE kind='purchases');
  DELETE FROM public.purchase_payments WHERE id IN(SELECT id FROM _retention_ids WHERE kind='supplier_payments');
  DELETE FROM public.purchase_items WHERE purchase_id IN(SELECT id FROM _retention_ids WHERE kind='purchases');
  DELETE FROM public.purchases WHERE id IN(SELECT id FROM _retention_ids WHERE kind='purchases');

  DELETE FROM public.cashbook_transactions WHERE id IN(SELECT id FROM _retention_ids WHERE kind='cashbook');
  after_cash:=public.p107_cash_net(NULL);
  UPDATE public.retention_control SET cash_carry=cash_carry+(before_cash->>'cash')::numeric-(after_cash->>'cash')::numeric,
    bank_carry=bank_carry+(before_cash->>'bank')::numeric-(after_cash->>'bank')::numeric,
    wallet_carry=wallet_carry+(before_cash->>'wallet')::numeric-(after_cash->>'wallet')::numeric WHERE id;
  DELETE FROM public.commission_transactions WHERE salary_period<to_char(job.cutoff AT TIME ZONE 'Asia/Bangkok','YYYY-MM')
    OR order_id IN(SELECT id FROM _retention_ids WHERE kind='orders')
    OR sales_return_id IN(SELECT id FROM _retention_ids WHERE kind='returns')
    OR cashbook_transaction_id IN(SELECT id FROM _retention_ids WHERE kind='cashbook');
  DELETE FROM public.payroll_entries WHERE period<to_char(job.cutoff AT TIME ZONE 'Asia/Bangkok','YYYY-MM');
  DELETE FROM public.payroll_adjustments WHERE period<to_char(job.cutoff AT TIME ZONE 'Asia/Bangkok','YYYY-MM');
  DELETE FROM public.payroll_periods WHERE period<to_char(job.cutoff AT TIME ZONE 'Asia/Bangkok','YYYY-MM');

  -- Preserve physical stock. Purge is never an inventory cancellation.
  DELETE FROM public.inventory_movements WHERE created_at<job.cutoff OR order_id IN(SELECT id FROM _retention_ids WHERE kind='orders');
  INSERT INTO public.retention_retired_requests(digest)
    SELECT encode(sha256(convert_to('inventory_documents:'||d.actor_id||':'||d.request_key,'UTF8')),'hex')
    FROM public.inventory_documents d WHERE d.created_at<job.cutoff
      AND NOT EXISTS(SELECT 1 FROM public.inventory_movements m WHERE m.document_id=d.id)
      AND NOT EXISTS(SELECT 1 FROM public.sales_returns r WHERE r.inventory_document_id=d.id)
    ON CONFLICT DO NOTHING;
  DELETE FROM public.inventory_documents d WHERE d.created_at<job.cutoff
    AND NOT EXISTS(SELECT 1 FROM public.inventory_movements m WHERE m.document_id=d.id)
    AND NOT EXISTS(SELECT 1 FROM public.sales_returns r WHERE r.inventory_document_id=d.id);
  INSERT INTO public.retention_inventory_balances(product_id,quantity_opening,cutoff)
    SELECT s.product_id,s.quantity-COALESCE((SELECT sum(delta) FROM public.inventory_movements WHERE product_id=s.product_id),0),job.cutoff
    FROM public.inventory_balances s ON CONFLICT(product_id) DO UPDATE SET quantity_opening=EXCLUDED.quantity_opening,cutoff=EXCLUDED.cutoff;
  DELETE FROM public.inventory_order_positions WHERE order_id IN(SELECT id FROM _retention_ids WHERE kind='orders');
  IF to_regclass('public.inventory_sync_outbox') IS NOT NULL THEN
    EXECUTE 'DELETE FROM public.inventory_sync_outbox WHERE NOT pending AND order_id IN(SELECT id FROM _retention_ids WHERE kind=''orders'')';
  END IF;
  DELETE FROM public.order_items WHERE order_id IN(SELECT id FROM _retention_ids WHERE kind='orders');
  DELETE FROM public.orders WHERE id IN(SELECT id FROM _retention_ids WHERE kind='orders');
  DELETE FROM public.draft_orders WHERE id IN(SELECT id FROM _retention_ids WHERE kind='drafts');

  INSERT INTO public.retention_customer_balances(customer_id,cutoff,debt_opening,payment_carry)
    SELECT customer_id,job.cutoff,opening,payment_carry FROM _retention_openings
    ON CONFLICT(customer_id) DO UPDATE SET cutoff=EXCLUDED.cutoff,debt_opening=EXCLUDED.debt_opening,
      payment_carry=EXCLUDED.payment_carry,updated_at=now();

  -- Remove historical JSON copies but preserve every other customer field.
  UPDATE public.customers c SET debt_history=COALESCE((SELECT jsonb_agg(entry) FROM jsonb_array_elements(c.debt_history) entry
    WHERE COALESCE(NULLIF(entry->>'date','')::timestamptz,NULLIF(entry->>'transactionDate','')::timestamptz,'-infinity'::timestamptz)>=job.cutoff
      AND NOT public.p107_payload_references_removed(entry)),'[]')
    WHERE jsonb_typeof(c.debt_history)='array' AND c.debt_history<>'[]'::jsonb;
  UPDATE public.audit_logs SET old_data=public.p107_scrub_history_json(old_data),new_data=public.p107_scrub_history_json(new_data)
    WHERE old_data IS NOT NULL OR new_data IS NOT NULL;
  UPDATE public.activity_logs SET old_value=public.p107_scrub_history_json(old_value),new_value=public.p107_scrub_history_json(new_value),
    changes=public.p107_scrub_history_json(changes),metadata=public.p107_scrub_history_json(metadata);
  DELETE FROM public.audit_logs log WHERE log.created_at<job.cutoff
    OR log.record_id IN(SELECT id FROM _retention_ids)
    OR public.p107_payload_references_removed(log.old_data) OR public.p107_payload_references_removed(log.new_data);
  DELETE FROM public.activity_logs log WHERE log.created_at<job.cutoff
    OR log.target_id IN(SELECT id FROM _retention_ids)
    OR log.order_id IN(SELECT id FROM _retention_ids WHERE kind='orders')
    OR public.p107_payload_references_removed(log.old_value) OR public.p107_payload_references_removed(log.new_value)
    OR public.p107_payload_references_removed(log.changes) OR public.p107_payload_references_removed(log.metadata);
  IF job.include_archive AND to_regclass('public.activity_logs_archive_pre_20260804') IS NOT NULL THEN
    TRUNCATE ONLY public.activity_logs_archive_pre_20260804 CONTINUE IDENTITY RESTRICT;
  END IF;

  IF EXISTS(SELECT 1 FROM public.customers c JOIN _retention_preserved p ON p.kind='customers' AND p.id=c.id
    WHERE to_jsonb(c)-'debt_history' IS DISTINCT FROM p.payload)
    OR (SELECT count(*) FROM public.customers)<>(SELECT count(*) FROM _retention_preserved WHERE kind='customers') THEN
    RAISE EXCEPTION 'Đã hủy dọn: thông tin hoặc số cuối cùng của khách thay đổi.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.suppliers s JOIN _retention_preserved p ON p.kind='suppliers' AND p.id=s.id WHERE to_jsonb(s) IS DISTINCT FROM p.payload)
    OR (SELECT count(*) FROM public.suppliers)<>(SELECT count(*) FROM _retention_preserved WHERE kind='suppliers') THEN
    RAISE EXCEPTION 'Đã hủy dọn: số cuối cùng nhà cung cấp thay đổi.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.inventory_balances s JOIN _retention_preserved p ON p.kind='stock' AND p.id=s.product_id WHERE to_jsonb(s) IS DISTINCT FROM p.payload)
    OR (SELECT count(*) FROM public.inventory_balances)<>(SELECT count(*) FROM _retention_preserved WHERE kind='stock') THEN
    RAISE EXCEPTION 'Đã hủy dọn: tồn kho hiện tại thay đổi.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.starting_balances s JOIN _retention_preserved p ON p.kind='starting_balances' AND p.id=s.id WHERE to_jsonb(s) IS DISTINCT FROM p.payload) THEN
    RAISE EXCEPTION 'Đã hủy dọn: số dư quỹ gốc thay đổi.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.customers c CROSS JOIN LATERAL public.p74_customer_debt_ledger_balance(c.id) b
    WHERE round(COALESCE(c.debt,0)) IS DISTINCT FROM b.calculated_balance) THEN
    RAISE EXCEPTION 'Đã hủy dọn: số chuyển kỳ không khớp công nợ hiện tại.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.suppliers s LEFT JOIN public.retention_supplier_balances cp ON cp.supplier_id=s.id
    WHERE round(s.total_purchase) IS DISTINCT FROM round(cp.purchase_carry+COALESCE((SELECT sum(total_amount) FROM public.purchases WHERE supplier_id=s.id AND status='completed'),0))
      OR round(s.total_paid) IS DISTINCT FROM round(cp.paid_carry+COALESCE((SELECT sum(amount) FROM public.purchase_payments WHERE supplier_id=s.id AND status='completed'),0))
      OR round(s.debt) IS DISTINCT FROM round(s.opening_debt+cp.purchase_carry-cp.paid_carry
      +COALESCE((SELECT sum(total_amount) FROM public.purchases WHERE supplier_id=s.id AND status='completed'),0)
      -COALESCE((SELECT sum(amount) FROM public.purchase_payments WHERE supplier_id=s.id AND status='completed'),0))) THEN
    RAISE EXCEPTION 'Đã hủy dọn: số chuyển kỳ nhà cung cấp không khớp.';
  END IF;
  IF EXISTS(SELECT 1 FROM public.retention_control c WHERE id AND
    (c.cash_carry+(after_cash->>'cash')::numeric<>old_control.cash_carry+(before_cash->>'cash')::numeric
      OR c.bank_carry+(after_cash->>'bank')::numeric<>old_control.bank_carry+(before_cash->>'bank')::numeric
      OR c.wallet_carry+(after_cash->>'wallet')::numeric<>old_control.wallet_carry+(before_cash->>'wallet')::numeric)) THEN
    RAISE EXCEPTION 'Đã hủy dọn: tổng tiền mặt/ngân hàng/ví thay đổi.';
  END IF;
  -- Force deferred financial constraints BEFORE marking the job completed.
  SET CONSTRAINTS ALL IMMEDIATE;
  UPDATE public.retention_control SET cutoff=job.cutoff,epoch=epoch+1,updated_at=now() WHERE id RETURNING epoch INTO epoch_after;
  result_payload:=jsonb_build_object('success',true,'job_id',job.id,'cutoff',job.cutoff,'epoch',epoch_after,
    'counts',preview->'counts','customers_preserved',(SELECT count(*) FROM _retention_preserved WHERE kind='customers'),
    'verified',true,'completed_at',now(),'note','Đã xóa chi tiết; mọi số cuối cùng được bảo toàn. Dung lượng đĩa có thể cần bảo trì riêng.');
  UPDATE public.retention_jobs SET state='completed',completed_at=now(),result=result_payload,
    backend_pid=NULL,transaction_id=NULL WHERE id=job.id;
  PERFORM set_config('app.retention_job','',true);
  RETURN result_payload;
END $$;

-- Preserve master timestamps during the narrow, authenticated purge only.
DO $migration$
DECLARE original text;
BEGIN
  SELECT pg_get_functiondef('public.p0_force_actor_column()'::regprocedure) INTO original;
  EXECUTE regexp_replace(original, 'BEGIN', 'BEGIN IF public.p107_is_executing() THEN RETURN NEW; END IF;');
END $migration$;

DO $migration$
DECLARE entry record;
BEGIN
  FOR entry IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'p107_%' OR p.proname IN(
      'rpc_retention_status','rpc_preview_monthly_retention','rpc_prepare_monthly_retention','rpc_execute_monthly_retention','rpc_retention_job')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',entry.signature);
  END LOOP;
END $migration$;
GRANT EXECUTE ON FUNCTION public.rpc_retention_status(), public.rpc_preview_monthly_retention(boolean),
  public.rpc_prepare_monthly_retention(uuid,boolean),public.rpc_execute_monthly_retention(uuid,text,text),
  public.rpc_retention_job(uuid) TO authenticated;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0107','Backup-bound two-month retention with invariant checks, signed opening balances and replay protection') ON CONFLICT DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
