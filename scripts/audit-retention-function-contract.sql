-- Catalog only: no application rows, credentials, backup or purge execution.
BEGIN READ ONLY;
SELECT jsonb_agg(jsonb_build_object(
  'signature',p.oid::regprocedure::text,
  'body_md5',md5(replace(p.prosrc,chr(13),'')),
  'security_definer',p.prosecdef,
  'volatility',p.provolatile,
  'settings',p.proconfig,
  'authenticated_execute',has_function_privilege('authenticated',p.oid,'EXECUTE'),
  'anonymous_execute',has_function_privilege('anon',p.oid,'EXECUTE')
) ORDER BY p.oid::regprocedure::text) AS function_contract
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND (p.proname LIKE 'p107_%' OR p.proname LIKE 'p108_%'
  OR p.proname LIKE 'rpc_%retention%'
  OR p.proname IN ('rpc_record_independent_return','rpc_list_independent_returns','rpc_cancel_sales_return',
    'p106_cancel_order_return','p3_sales_return_response','p74_customer_debt_ledger_balance',
    'p74_guard_customer_debt_invariant','require_authenticated_profile','p0_force_actor_column',
    'p4_recompute_supplier','rpc_get_cashbook_window','rpc_get_phase5_dashboard',
    'rpc_get_phase5_report','rpc_get_employee_business_report'));
ROLLBACK;
