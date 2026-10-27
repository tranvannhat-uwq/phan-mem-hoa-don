-- Read-only production audit for the source at dcfecc3 and migrations through 0117.
-- Run the whole file in the intended Supabase project's SQL Editor as owner.
-- No prepare/execute/maintenance/configuration mutation RPC is invoked.
-- Results contain catalog metadata and aggregate counts only.
-- A failed statement requires ROLLBACK; do not remove READ ONLY to retry.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
SET LOCAL TIME ZONE 'Asia/Bangkok';
SELECT pg_advisory_xact_lock_shared(hashtextextended('billing-monthly-retention', 0));

-- 1. Versions, cutoff, current data integrity and blockers; no customer details.
SELECT jsonb_build_object(
  'checked_at', now(), 'read_only', current_setting('transaction_read_only'),
  'versions', (SELECT jsonb_agg(version ORDER BY version) FROM public.schema_migrations
    WHERE version BETWEEN '0106' AND '0118'),
  'missing_versions', (SELECT COALESCE(jsonb_agg(lpad(v::text,4,'0')), '[]'::jsonb)
    FROM generate_series(106,118) AS v
    WHERE NOT EXISTS(SELECT 1 FROM public.schema_migrations m WHERE m.version=lpad(v::text,4,'0'))),
  'customers', (SELECT count(*) FROM public.customers),
  'orders', (SELECT count(*) FROM public.orders),
  'returns_by_source', (SELECT COALESCE(jsonb_object_agg(source_kind,n),'{}'::jsonb)
    FROM (SELECT source_kind,count(*) n FROM public.sales_returns GROUP BY source_kind) r),
  'customer_debt_mismatches', (SELECT count(*) FROM public.customers c
    CROSS JOIN LATERAL public.p74_customer_debt_ledger_balance(c.id) b
    WHERE b.calculated_balance IS NOT NULL AND round(COALESCE(c.debt,0)) IS DISTINCT FROM b.calculated_balance),
  'invalid_customer_ledger_rows', (SELECT count(*) FROM public.customer_debt_transactions
    WHERE balance_before IS NULL OR balance_after IS NULL OR debt_change IS NULL
      OR round(balance_after) IS DISTINCT FROM round(balance_before+debt_change)),
  'supplier_balance_mismatches', (SELECT count(*) FROM public.suppliers
    WHERE round(debt) IS DISTINCT FROM round(opening_debt+total_purchase-total_paid)),
  'trigger_contract_matches', (SELECT expected_trigger_hash=public.p107_trigger_fingerprint()
    FROM public.retention_control WHERE id),
  'retention', (SELECT jsonb_build_object('epoch',epoch,'cutoff',cutoff,
    'next_cutoff',public.p107_cutoff()) FROM public.retention_control WHERE id),
  'jobs_by_state', (SELECT COALESCE(jsonb_object_agg(state,n),'{}'::jsonb)
    FROM (SELECT state,count(*) n FROM public.retention_jobs GROUP BY state) j),
  'dealer_support_selection_confirmed', (SELECT selection_confirmed FROM public.dealer_support_control WHERE id),
  'selected_skus', (SELECT count(*) FROM public.products WHERE retain_dealer_support_history),
  'preview', public.p107_preview(true)
) AS retention_current_assessment;

-- 2. Exact source/ACL/configuration comparison against the tested local database.
-- Settings are compared as sets. MD5 identifies drift, not data authenticity.
WITH expected(signature,body_md5,security_definer,volatility,settings,authenticated_execute,anonymous_execute) AS (
  VALUES
    ('p0_force_actor_column()', '88af40f802fdd6ba46f4a293fd159799', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p106_cancel_order_return(text,text)', '43817413bf1b0ca1bb8f9d53cadb087c', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_assert_epoch()', '3db28216d76a28957686c5c485705747', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_cash_net(timestamp with time zone)', '57270d59be724699266670860423fd13', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_cutoff()', '36a13254c28c3778ebc187ea5d4207e8', false, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_fingerprint(boolean)', 'a661c975935921832d16c8b9cc1a0a8e', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_guard_document_write()', '7bd17413d5597940336cf5ce49c18f8e', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_guard_master_write()', '94b86dc3fb92cc89db452df3381d4df8', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_is_executing()', 'fa27efca61d1f7783c9878be16d3e74d', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_lock_scope(boolean)', 'b9aa01c67ed4ed36072defcac7036461', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_payload_references_removed(jsonb)', '5e9991251610d1ff1ffe1dd982084bac', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_plan(timestamp with time zone)', '6bf78efcff40b6192526403980190255', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_preview(boolean)', '823d07d1a286143549c770b5bc9cbcba', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_require_admin()', '57f4073cc96a6e7ff7d26ffc59c06c9c', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_scrub_history_json(jsonb)', 'e5975e2ec88c4040c7dadd2fd850d59d', false, 'i', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_snapshot_tables(boolean)', 'b3dadc0057b446d12ff25b03e16ed712', false, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_suppress_purge_payload()', '9821390c89940ec21465c0af68663652', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p107_trigger_fingerprint()', '52b453f16cf86d1e59f4b93c8e733503', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p108_dashboard_returns(jsonb,jsonb)', '095854d7296b02124d3209e2268c3c61', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p108_independent_items(jsonb)', 'c92faf9cc583f3d0a230314decca371a', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p108_merge_metrics(jsonb,jsonb,text,text[])', 'bdfc2eccf5c7254ab3adb6499e087920', false, 'i', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p108_report_retention(jsonb,jsonb)', '8372e799b3d45293e900411c582ee4c8', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p114_guard_product_selection()', '0e5834105bcaa86f2f4896e32768d767', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p114_preserve_support(timestamp with time zone)', 'aeaeab2718c08fe7512410cc8b4075a8', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p114_return_status_changed()', '4a5bf598d7910d1627b0f11ea85701bc', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p114_source_lines()', 'aea9d944022654fe00699148addcc0be', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p3_sales_return_response(text)', '161284627692bd05790a17988259d9bc', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p4_recompute_supplier(text)', '554057c2501208c3328c8bcf3575b7e0', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p74_customer_debt_ledger_balance(text)', '5c13b8cfd13aa8c433f12d105438744e', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p74_guard_customer_debt_invariant()', '74c740091ee21360b00458ecfe8148ec', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('require_authenticated_profile()', 'd49794fdfdde18c271ef17f4f53c3151', true, 's', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_amend_cashbook_transaction(text,jsonb)', '8dc1c96c2f17db10a9ecbe385042f577', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_cancel_sales_return(text)', '7721adc53c9a8e3c898788c9a28850ad', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('rpc_cancel_sales_return(text,text)', '930b33263e25d944043eb6176e6f8b90', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_dealer_support_history(text,integer,integer)', 'cb2e1230b1458ef28aebb62328443ab0', true, 's', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_dealer_support_products(text,integer,integer)', 'fb87721b43dbd81465b77af1e0e02053', true, 's', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_execute_monthly_retention(uuid,text,text)', 'c264fecda78dca327179c645d0d1f951', true, 'v', ARRAY['search_path=pg_catalog, public','statement_timeout=60s']::text[], true, false),
    ('rpc_get_cashbook_window(timestamp with time zone,timestamp with time zone)', 'de71a4700276c24f80ab48eb09c8ee8c', false, 'v', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_get_employee_business_report(jsonb)', '93a9bff8d81f193da0b41dc8953f5384', true, 's', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_get_phase5_dashboard(jsonb)', 'c30e8597e3f8103bb618f6d94dad1be4', true, 's', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_get_phase5_report(jsonb)', '58c98cf4265e9beceadac4542bb16ee3', true, 's', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_import_customer_financial_baselines(jsonb)', '516af2520e9df2335fb1774071cd3dce', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_list_independent_returns(jsonb)', '8bd4e355c9fcab0b58faed15037e4dca', true, 's', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_prepare_monthly_retention(uuid,boolean)', 'a941d310473c1e1553dfd2860808d7c8', true, 'v', ARRAY['search_path=pg_catalog, public','statement_timeout=60s']::text[], true, false),
    ('rpc_preview_monthly_retention(boolean)', '61a7464be7e6da79a4660f4b330855d4', true, 's', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_record_independent_return(jsonb)', '8a0fb82345cdadfd3f2c5f23a713df6d', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_retention_cash_opening()', '11bc2452c1a0ca1ec64d11e1a44c5294', true, 's', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_retention_job(uuid)', '5bae7f14288bb130358f918b3b3cc8b5', true, 's', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_retention_status()', '46204f88e4312383021e1cbd64b413f2', true, 's', ARRAY['search_path=pg_catalog, public']::text[], true, false),
    ('rpc_set_dealer_support_products(jsonb)', '04dac7edddf0b604079c35b764bcf89b', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], true, false)
,
    ('p118_assert_kept()', '43fc74d28f426ef953755251d457f96c', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p118_cache_kept()', 'bb4799a73ae29122de51384bdfe0ed28', true, 'v', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p118_is_kept(text,jsonb)', '8afbcfb5584bb886cdada3765d7a3255', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p118_kept_rows()', 'c54105b65993e7fd05311e121212b987', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p118_original_plan(timestamp with time zone)', 'a1943182edc7b89c0e7191f6f8479a4f', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p118_purge_support_lines()', '2da1e09ed59ffadaa2096a2d49d1f235', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p118_row_key(jsonb)', '2ff37427286417ea9165eb3e97e5ea3f', false, 'i', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('p118_support_issues(timestamp with time zone)', '6cfa0ce20a4dac7206ad1abc94796256', true, 's', ARRAY['search_path=pg_catalog, public']::text[], false, false),
    ('rpc_hold_retention_warnings(boolean)', '30e6b068082fbf1192574e1e0b8e9f27', true, 'v', ARRAY['search_path=pg_catalog, public','statement_timeout=60s']::text[], true, false),
    ('rpc_retention_review_orders(integer,integer)', '895e34f2b5355ca05d9f160c79029054', true, 's', ARRAY['search_path=pg_catalog, public']::text[], true, false)
), compared AS (
  SELECT expected.signature,
    p.oid IS NOT NULL AS present,
    md5(replace(p.prosrc,chr(13),''))=expected.body_md5 AS body_matches,
    p.prosecdef=expected.security_definer AS definer_matches,
    p.provolatile::text=expected.volatility AS volatility_matches,
    (COALESCE(p.proconfig,'{}'::text[]) @> COALESCE(expected.settings,'{}'::text[])
      AND COALESCE(p.proconfig,'{}'::text[]) <@ COALESCE(expected.settings,'{}'::text[])) AS settings_match,
    has_function_privilege('authenticated',p.oid,'EXECUTE')=expected.authenticated_execute AS authenticated_acl_matches,
    has_function_privilege('anon',p.oid,'EXECUTE')=expected.anonymous_execute AS anonymous_acl_matches
  FROM expected LEFT JOIN pg_proc p ON p.oid=to_regprocedure('public.'||expected.signature)
)
SELECT jsonb_build_object('functions_checked',count(*),
  'differences',COALESCE(jsonb_agg(to_jsonb(compared)) FILTER(WHERE NOT COALESCE(
    present AND body_matches AND definer_matches AND volatility_matches AND settings_match
      AND authenticated_acl_matches AND anonymous_acl_matches,false)),'[]'::jsonb)) AS retention_function_contract
FROM compared;

-- 3. Application-role read-only RPCs and private boundaries.
-- These are LOCAL transaction settings; no profile, Auth user or row is changed.
DO $read_context$
DECLARE actor_id text;
BEGIN
  SELECT auth_user_id::text INTO actor_id FROM public.profiles
    WHERE role='admin' AND is_active ORDER BY id LIMIT 1;
  IF actor_id IS NULL THEN RAISE EXCEPTION 'No active Admin found for read-only application smoke test'; END IF;
  PERFORM set_config('request.jwt.claim.sub',actor_id,true);
  PERFORM set_config('request.headers',jsonb_build_object('x-retention-epoch',
    (SELECT epoch::text FROM public.retention_control WHERE id))::text,true);
END $read_context$;
SET LOCAL ROLE authenticated;
SELECT jsonb_build_object(
  'read_only',current_setting('transaction_read_only'),
  'status_ok',public.rpc_retention_status() IS NOT NULL,
  'preview',public.rpc_preview_monthly_retention(true),
  'dashboard_ok',public.rpc_get_phase5_dashboard('{}') IS NOT NULL,
  'employee_report_ok',public.rpc_get_employee_business_report('{}') IS NOT NULL,
  'cashbook_ok',public.rpc_get_cashbook_window(date_trunc('month',now()),now()+interval '1 day') IS NOT NULL,
  'independent_return_list_ok',public.rpc_list_independent_returns('{"limit":1}') IS NOT NULL,
  'support_configuration_ok',public.rpc_dealer_support_products('',0,1) IS NOT NULL,
  'reconciliation_queue_ok',public.rpc_retention_review_orders(0,1) IS NOT NULL,
  'reconciliation_private',NOT has_table_privilege(current_user,'public.retention_review_orders','SELECT')
    AND NOT has_function_privilege(current_user,'public.p118_kept_rows()','EXECUTE')
    AND NOT has_function_privilege(current_user,'public.p107_plan(timestamp with time zone)','EXECUTE'),
  'jobs_private',NOT has_table_privilege(current_user,'public.retention_jobs','SELECT'),
  'support_private',NOT has_table_privilege(current_user,'public.dealer_support_history','SELECT'),
  'epoch_helper_private',NOT has_function_privilege(current_user,'public.p107_assert_epoch()','EXECUTE'),
  'return_response_private',NOT has_function_privilege(current_user,'public.p3_sales_return_response(text)','EXECUTE'),
  'cancelled_order_trigger_private',NOT has_function_privilege(current_user,'public.p84_guard_cancelled_order_debt()','EXECUTE'),
  'anon_execute_denied',NOT has_function_privilege('anon','public.rpc_execute_monthly_retention(uuid,text,text)','EXECUTE')
) AS retention_application_smoke;
ROLLBACK;
