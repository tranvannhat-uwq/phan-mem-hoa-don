# P0 database migrations

This directory is the only ordered migration source after the legacy SQL files
in the repository. The legacy files remain unchanged because some of them may
already have been applied to an existing database.

Run these files in order on a staging clone first:

1. `0001_core_schema_and_migration_registry.sql`
2. `0002_auth_profiles_and_rls.sql`
3. `0003_secure_rpc_boundary.sql`
4. `0004_lock_down_legacy_objects.sql`
5. `0005_profile_identity_integrity.sql`
6. `0006_authoritative_order_pricing_and_idempotency.sql`
7. `0007_payments_debt_cashbook_and_order_reversals.sql`
8. `0008_authoritative_sales_returns_and_reversals.sql`
9. `0009_supplier_purchases_debt_and_payments.sql`
10. `0010_supplier_updated_at_compatibility.sql`
11. `0011_confirm_order_variable_conflict_fix.sql`
12. `0012_phase5_reporting_kpi_payroll.sql`
13. `0013_legacy_cashbook_customer_and_order_compatibility.sql`
14. `0014_sales_return_variable_conflict_fix.sql`
15. `0015_customer_opening_financial_import.sql`
16. `0016_customer_import_rpc_variable_conflict_fix.sql`
17. `0017_privileged_order_business_date.sql`
18. `0018_quick_customer_creation_rpc.sql`
19. `0019_order_amendment_and_customer_advance.sql`
20. `0020_customer_debt_adjustment_credit.sql`
21. `0021_enable_scoped_realtime.sql`
22. `0022_dot_color_surcharge.sql`
23. `0023_authoritative_color_surcharges.sql`
24. `0024_sale_managed_customer_debt_history.sql`
25. `0025_global_price_list_order_override.sql`
26. `0026_sale_managed_customer_order_history.sql`

Every file is additive and records its version in `public.schema_migrations`.
Apply each version once; the migration table is the source of truth for the
next pending file. None of the P0 migrations deletes business rows.

The clean-database target is a clean **Supabase** project (the chain depends on
`auth.users` and `auth.uid()`), not generic PostgreSQL. Migration `0001` stops
without changing data if a legacy `wl_*` deployment is detected: no authoritative
`wl_*` production schema exists in this repository, so mapping it would require
an exported schema rather than a guess.

The canonical pre-P0 business implementations were identified as:

- `fix_customer_debt_ledger.sql`: order confirmation, receipt, sales return,
  and return cancellation.
- `fix_cancel_customer_payment.sql`: receipt cancellation.
- `update_supabase_schema.sql`: debt adjustment and paginated read RPCs. The
  legacy file is syntactically incomplete at its debt-adjustment function and
  must not be executed again.

The reviewed public RPC signatures are defined once by `0003`/`0004`. Legacy
overloads remain physically present on an upgraded database only to avoid a
destructive drop, but `0004` removes `EXECUTE` from `PUBLIC`, `anon`, and
`authenticated`; it then grants only the reviewed signatures back to
`authenticated`.

From this point onward, do not run a legacy root-level SQL file after the P0
migrations. Doing so can recreate permissive policies or overwrite a secured
RPC. Follow `docs/P0_BACKUP_AND_STAGING.md` for backup, verification, rollout,
and restore instructions.

Migration `0006` is Phase 1 of the final business scope. It makes the database
authoritative for active SKU validation, allowed price-list selection, price
inheritance, monetary calculations, immutable order snapshots and idempotent
finalization. It does not call inventory or production objects. Run
`migrations/tests/phase1_order_pricing_integration.sql` on staging after it.

Migration `0007` is Phase 2. It makes customer collections and manual cashbook
entries idempotent, protects the customer debt ledger as append-only, moves
starting-balance changes behind a reviewed RPC, and cancels receipts/orders by
recording compensating transactions. It does not call inventory, production,
sales-return or supplier-purchase logic. Run
`migrations/tests/phase2_financial_reversals_integration.sql` on staging after it.

Migration `0008` is Phase 3. It validates returned quantities against immutable
order-item snapshots, calculates refund values in the database, separates debt
reduction from actual cash refund, updates order/customer revenue, and appends
commission/debt/cashbook reversals. It has no inventory or production coupling.
Run `migrations/tests/phase3_sales_returns_integration.sql` on staging after it.

Migration `0009` is Phase 4. It creates authoritative supplier purchases,
purchase items, supplier payments and an append-only supplier debt ledger. The
database calculates purchase totals, writes linked payment vouchers/cashbook
entries, and cancels purchases or payments with compensating transactions. It
does not read or update inventory/production objects. Run
`migrations/tests/phase4_supplier_purchases_integration.sql` on staging after it.

Migration `0010` is the additive compatibility repair for legacy supplier
tables that have `created_at` but not `updated_at`. Migration `0009` is kept
immutable after deployment; `0010` adds the timestamp required by its supplier
RPCs without rewriting business rows. Run the Phase 4 integration suite again
after applying it.

Migration `0011` recompiles the Phase 1 order-confirmation RPC with explicit
PL/pgSQL variable precedence. It fixes legacy column/local-variable name
collisions such as `idempotency_key` without changing pricing, debt, inventory,
production or order data. Run the Phase 1 integration suite after applying it.

Migration `0013` adds strong-link metadata for historical cashbook rows and a
single transactional cancellation RPC that classifies receipts/payments before
reversing customer or supplier debt. It also permits paid-order cancellation to
turn preserved receipts into customer credit instead of deleting money or
forcing debt to zero. The old cancellation RPC signatures remain as wrappers.
It has no inventory or production dependency. Run
`migrations/tests/phase6_legacy_compatibility_integration.sql` after applying it.

Migration `0015` adds an Admin/Accounting-only RPC for importing legacy
customer financial baselines. Re-importing replaces the previous imported
contribution instead of adding it again, while totals produced later by orders,
returns and payments remain intact. Direct API writes to both operational totals
and imported baseline columns stay blocked.

Migration `0016` fixes the `customer_id is ambiguous` error for databases that
already ran the first revision of `0015`. It changes only PL/pgSQL identifier
resolution, reasserts the RPC security settings and leaves all imported totals,
ledgers and formulas unchanged.

Migration `0017` lets Admin/Accounting preserve the actual business day for
orders entered after a weekend or holiday. The chosen date drives order history,
debt-ledger timing and reporting, while confirmation/audit timestamps retain the
real posting time. Sale-role payload dates are ignored and future dates are rejected.

Migration `0018` adds a narrow authenticated RPC for creating a customer from
the invoice screen. Admin/Accounting may choose an active manager; Sale users
are forcibly assigned as the new customer's manager. Financial balances remain
server-owned, direct customer-table insert policies are not widened, and every
quick creation is audited.

Migration `0019` lets Admin/Accounting amend a settled order by atomically
cancelling the immutable original and confirming a replacement. Orders with
active returns remain locked. It also adds customer receipts that may create a
negative customer balance (advance credit) for later orders to consume.

Migration `0020` exposes the existing audited customer-debt correction workflow
in a way that supports the signed balance convention from `0019`. Admin and
Accounting may set either a receivable or advance-credit balance, but every
change still requires a reason and appends both debt-ledger and audit records.

Migration `0021` registers the active order, customer, cashbook and catalog tables
with Supabase Realtime. It changes publication metadata only, preserves every
business row and continues to rely on the existing RLS policies for event access.

Migration `0026` lets a Sale read finalized order history for a dealer already
inside that Sale's managed or assigned customer scope. It keeps price-list
authorization, draft ownership, finalized-order immutability and all mutation
permissions unchanged.
