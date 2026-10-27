-- Aggregate/catalog smoke check only. No backup, maintenance toggle or purge.
BEGIN READ ONLY;
DO $verify$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('billing-monthly-retention',0));
  PERFORM set_config('app.retention_verified_meta',jsonb_build_object(
    'versions',(SELECT jsonb_agg(version ORDER BY version) FROM public.schema_migrations WHERE version IN('0106','0107','0108','0109','0110','0111','0112','0113')),
    'customers',(SELECT count(*) FROM public.customers),'orders',(SELECT count(*) FROM public.orders),
    'purge_jobs',(SELECT count(*) FROM public.retention_jobs),
    'debt_mismatches',(SELECT count(*) FROM public.customers c CROSS JOIN LATERAL public.p74_customer_debt_ledger_balance(c.id) b
      WHERE b.calculated_balance IS NOT NULL AND round(c.debt) IS DISTINCT FROM b.calculated_balance),
    'checkpoint_maintenance_policy',EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.retention_customer_balances'::regclass
      AND pg_get_expr(polqual,polrelid) LIKE '%maintenance_access_allowed%'),
    'employee_company_opening_patch',(SELECT (length(prosrc)-length(replace(prosrc,
      'AND (requested_company IS NULL OR ledger.retention_company_id=requested_company OR EXISTS (','')))/
      length('AND (requested_company IS NULL OR ledger.retention_company_id=requested_company OR EXISTS (')=2
      FROM pg_proc WHERE oid='public.rpc_get_employee_business_report(jsonb)'::regprocedure),
    'employee_return_series_patch',(SELECT strpos(prosrc,
      'CASE WHEN retention_separate_return THEN -COALESCE(NULLIF(total_refund,0),total_return_amount,0) ELSE 0 END')>0
      FROM pg_proc WHERE oid='public.rpc_get_employee_business_report(jsonb)'::regprocedure)
  )::text,true);
  PERFORM set_config('request.jwt.claim.sub',(SELECT auth_user_id::text FROM public.profiles WHERE role='admin' AND is_active ORDER BY id LIMIT 1),true);
  PERFORM set_config('request.headers',jsonb_build_object('x-retention-epoch',
    (SELECT epoch::text FROM public.retention_control WHERE id))::text,true);
END $verify$;
SET LOCAL ROLE authenticated;
SELECT jsonb_build_object('checked_at',now(),'read_only',current_setting('transaction_read_only'),
  'metadata',current_setting('app.retention_verified_meta')::jsonb,
  'status',public.rpc_retention_status(),'preview',public.rpc_preview_monthly_retention(true),
  'dashboard_ok',public.rpc_get_phase5_dashboard('{}') IS NOT NULL,
  'employee_report_ok',public.rpc_get_employee_business_report('{}') IS NOT NULL,
  'cashbook_ok',public.rpc_get_cashbook_window(date_trunc('month',now()),now()+interval '1 day') IS NOT NULL,
  'independent_return_list_ok',public.rpc_list_independent_returns('{}') IS NOT NULL,
  'helper_private',NOT has_function_privilege(current_user,'public.p107_assert_epoch()','EXECUTE'),
  'return_response_private',NOT has_function_privilege(current_user,'public.p3_sales_return_response(text)','EXECUTE'),
  'jobs_table_private',NOT has_table_privilege(current_user,'public.retention_jobs','SELECT'),
  'anon_execute_denied',NOT has_function_privilege('anon','public.rpc_execute_monthly_retention(uuid,text,text)','EXECUTE')
) AS installed_verification;
ROLLBACK;
