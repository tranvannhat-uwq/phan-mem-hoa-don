BEGIN;

-- A corrected financial posting stays in the append-only ledger. Hide only
-- an explicitly paired, zero-net mistake and its compensation from the normal
-- customer statement; accounting can still inspect both source rows.
CREATE TABLE IF NOT EXISTS public.customer_debt_history_suppressions (
  ledger_id text PRIMARY KEY
    REFERENCES public.customer_debt_transactions(id) ON DELETE RESTRICT,
  customer_id text NOT NULL,
  correction_key text NOT NULL,
  reason text NOT NULL,
  performed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_debt_history_suppressions_customer_idx
  ON public.customer_debt_history_suppressions(customer_id, created_at DESC);

ALTER TABLE public.customer_debt_history_suppressions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS customer_debt_history_suppressions_scoped_select
  ON public.customer_debt_history_suppressions;
CREATE POLICY customer_debt_history_suppressions_scoped_select
  ON public.customer_debt_history_suppressions
  FOR SELECT TO authenticated
  USING (
    public.current_profile_role() IN ('admin', 'accounting')
    OR (public.current_profile_role() = 'sale' AND public.can_access_customer(customer_id))
  );
REVOKE ALL ON TABLE public.customer_debt_history_suppressions FROM PUBLIC, anon;
GRANT SELECT ON TABLE public.customer_debt_history_suppressions TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.customer_debt_history_suppressions FROM authenticated;

-- The 17 October order was overwritten in place with Nguyen Van Manh's sale.
-- Duy Cuong's original 545,935 VND receivable was removed by its transfer-out
-- ledger row. Preserve the current order and both customers' other documents.
-- This repair is deliberately tied to the reviewed production rows and aborts
-- if another posting has changed Duy Cuong's balance since review.
DO $repair$
DECLARE
  v_customer public.customers%ROWTYPE;
  v_order public.orders%ROWTYPE;
  v_transfer public.customer_debt_transactions%ROWTYPE;
  v_amendment public.order_amendments%ROWTYPE;
  v_correction_id constant text := 'DTX-CORRECT-HD-20261017-00002802-DUY-CUONG';
  v_transfer_id constant text := 'DTX-OAM-OUT-HD-20261017-00002802-0002';
  v_correction_key constant text := '0100:HD-20261017-00002802:DUY-CUONG';
  v_customer_id constant text := 'cust-1785809266496-10-699';
  v_manh_id constant text := 'cust-1785809266506-82-793';
  v_order_id constant text := 'HD-20261017-00002802';
  v_actor constant text := 'migration-0100';
  v_ledger_sum numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM public.customer_debt_transactions WHERE id = v_correction_id) THEN
    IF (SELECT count(*) FROM public.customer_debt_history_suppressions
        WHERE correction_key = v_correction_key) <> 2 THEN
      RAISE EXCEPTION '0100 correction exists without its two history markers';
    END IF;
    RETURN;
  END IF;

  SELECT * INTO STRICT v_customer
  FROM public.customers WHERE id = v_customer_id FOR UPDATE;
  SELECT * INTO STRICT v_order
  FROM public.orders WHERE id = v_order_id FOR UPDATE;
  SELECT * INTO STRICT v_transfer
  FROM public.customer_debt_transactions WHERE id = v_transfer_id;
  SELECT * INTO STRICT v_amendment
  FROM public.order_amendments
  WHERE id = 'OAM-HD-20261017-00002802-0002';
  SELECT COALESCE(sum(debt_change), 0) INTO v_ledger_sum
  FROM public.customer_debt_transactions WHERE customer_id = v_customer_id;

  IF round(v_customer.debt) IS DISTINCT FROM 292200
     OR round(v_ledger_sum) IS DISTINCT FROM 292200 THEN
    RAISE EXCEPTION 'Duy Cuong debt changed after review; recheck before applying 0100';
  END IF;
  IF v_order.customer_id IS DISTINCT FROM v_manh_id
     OR v_order.status IS DISTINCT FROM 'settled'
     OR round(v_order.total_payable) IS DISTINCT FROM 317966
     OR round(v_order.debt_amount) IS DISTINCT FROM 317966 THEN
    RAISE EXCEPTION 'Nguyen Van Manh order no longer matches the reviewed state';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.orders newer
    WHERE newer.id = 'HD-20261019-00002873'
      AND newer.customer_id = v_customer_id
      AND newer.status = 'settled'
      AND round(newer.debt_amount) = 292200
  ) THEN
    RAISE EXCEPTION 'Duy Cuong newer 292200 order no longer matches the reviewed state';
  END IF;
  IF v_transfer.customer_id IS DISTINCT FROM v_customer_id
     OR v_transfer.order_id IS DISTINCT FROM v_order_id
     OR v_transfer.transaction_type IS DISTINCT FROM 'order_amend'
     OR round(v_transfer.debt_change) IS DISTINCT FROM -545935
     OR round(v_transfer.balance_before) IS DISTINCT FROM 545935
     OR round(v_transfer.balance_after) IS DISTINCT FROM 0
     OR v_amendment.old_data->>'customer_id' IS DISTINCT FROM v_customer_id
     OR v_amendment.new_data->>'customer_id' IS DISTINCT FROM v_manh_id
     OR round((v_amendment.old_data->>'debt_amount')::numeric) IS DISTINCT FROM 545935
     OR round((v_amendment.new_data->>'debt_amount')::numeric) IS DISTINCT FROM 317966 THEN
    RAISE EXCEPTION 'Transferred order snapshot differs from the reviewed evidence';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.customer_debt_history_suppressions
    WHERE ledger_id = v_transfer_id OR correction_key = v_correction_key
  ) THEN
    RAISE EXCEPTION 'Transfer-out already has a different correction marker';
  END IF;

  INSERT INTO public.customer_debt_transactions (
    id, customer_id, transaction_type, amount, debt_change,
    balance_before, balance_after, order_id, amends_ledger_id,
    description, created_by, transaction_date
  ) VALUES (
    v_correction_id, v_customer_id, 'adjust', 545935, 545935,
    292200, 838135, v_order_id, v_transfer_id,
    'Khôi phục nợ gốc 545.935 đ của Duy Cường sau khi mã đơn bị chuyển sang Nguyễn Văn Mạnh; giữ nguyên đơn mới 292.200 đ',
    v_actor, now()
  );

  UPDATE public.customers
  SET debt = 838135, updated_at = now(), updated_by = v_actor
  WHERE id = v_customer_id;

  INSERT INTO public.customer_debt_history_suppressions (
    ledger_id, customer_id, correction_key, reason, performed_by
  ) VALUES
    (v_transfer_id, v_customer_id, v_correction_key,
     'Bút toán chuyển nhầm đã được bù đủ 545.935 đ; ẩn cặp 0 đồng trong lịch sử thông thường', v_actor),
    (v_correction_id, v_customer_id, v_correction_key,
     'Bút toán bù cho lần chuyển nhầm; giữ trong sổ kiểm toán', v_actor);

  INSERT INTO public.audit_logs (
    table_name, action, record_id, old_data, new_data, performed_by
  ) VALUES (
    'customers', 'CORRECT_TRANSFERRED_ORDER_DEBT', v_customer_id,
    jsonb_build_object('debt', v_customer.debt, 'transferred_order_id', v_order_id,
                       'transfer_ledger_id', v_transfer_id),
    jsonb_build_object('debt', 838135, 'restored_debt', 545935,
                       'correction_ledger_id', v_correction_id,
                       'correction_key', v_correction_key,
                       'preserved_new_order_id', 'HD-20261019-00002873',
                       'manh_order_unchanged', true),
    v_actor
  );

  SELECT COALESCE(sum(debt_change), 0) INTO v_ledger_sum
  FROM public.customer_debt_transactions WHERE customer_id = v_customer_id;
  IF round(v_ledger_sum) IS DISTINCT FROM 838135 THEN
    RAISE EXCEPTION 'Corrected debt does not reconcile with the ledger';
  END IF;
END
$repair$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0100', 'Support audited correction of mistaken customer debt history pairs')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';
COMMIT;

SELECT customer.id, customer.debt,
       (SELECT sum(ledger.debt_change)
        FROM public.customer_debt_transactions ledger
        WHERE ledger.customer_id = customer.id) AS ledger_sum,
       (SELECT count(*)
        FROM public.customer_debt_history_suppressions marker
        WHERE marker.customer_id = customer.id
          AND marker.correction_key = '0100:HD-20261017-00002802:DUY-CUONG') AS hidden_pair_rows
FROM public.customers customer
WHERE customer.id = 'cust-1785809266496-10-699';
