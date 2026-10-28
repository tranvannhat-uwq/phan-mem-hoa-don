BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';

-- A current balance is the anchor after retention. Reverse only movements
-- after each boundary; no old voucher/item payload is downloaded or inferred.
CREATE OR REPLACE FUNCTION public.rpc_supplier_debt_report(p_input jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; start_at timestamptz; end_at timestamptz; boundary timestamptz;
  start_day date; end_day date; search_value text; supplier_value text; status_value text;
  min_value numeric; max_value numeric; page_offset integer; page_limit integer; result_value jsonb;
BEGIN
  actor:=public.require_authenticated_profile();
  IF actor.role NOT IN ('admin','accounting') OR NOT public.maintenance_access_allowed() THEN
    RAISE EXCEPTION 'Chỉ quản trị và kế toán được xem báo cáo công nợ NCC.' USING ERRCODE='42501';
  END IF;
  start_day:=(p_input->>'from')::date; end_day:=(p_input->>'to')::date;
  IF start_day IS NULL OR end_day IS NULL OR start_day>end_day OR NOT isfinite(start_day) OR NOT isfinite(end_day)
     OR end_day-start_day>3660 THEN RAISE EXCEPTION 'Chọn kỳ báo cáo hợp lệ (tối đa 10 năm).'; END IF;
  start_at:=(start_day::text||'T00:00:00+07:00')::timestamptz;
  end_at:=((end_day+1)::text||'T00:00:00+07:00')::timestamptz;
  SELECT cutoff INTO boundary FROM public.retention_control WHERE id;
  IF start_at<boundary THEN RAISE EXCEPTION 'Kỳ trước % đã đóng. Chỉ lập báo cáo từ ngày còn lưu.',to_char(boundary AT TIME ZONE 'Asia/Ho_Chi_Minh','DD/MM/YYYY'); END IF;
  search_value:=public.egress_normalize_catalog_text(COALESCE(p_input->>'query',''));
  supplier_value:=NULLIF(p_input->>'supplierId','');
  status_value:=COALESCE(NULLIF(p_input->>'status',''),'activity');
  IF status_value NOT IN ('activity','all','payable','advance','settled') THEN RAISE EXCEPTION 'Trạng thái công nợ không hợp lệ.'; END IF;
  min_value:=NULLIF(p_input->>'min','')::numeric; max_value:=NULLIF(p_input->>'max','')::numeric;
  IF COALESCE(min_value::text,'') IN ('NaN','Infinity','-Infinity') OR COALESCE(max_value::text,'') IN ('NaN','Infinity','-Infinity') OR min_value>max_value THEN
    RAISE EXCEPTION 'Khoảng công nợ không hợp lệ.';
  END IF;
  page_offset:=COALESCE((p_input->>'offset')::integer,0); page_limit:=LEAST(GREATEST(COALESCE((p_input->>'limit')::integer,20),1),100);
  IF page_offset<0 THEN RAISE EXCEPTION 'Trang báo cáo không hợp lệ.'; END IF;
  WITH candidates AS MATERIALIZED (
    SELECT s.id,s.code,s.name,s.debt
    FROM public.suppliers s WHERE (supplier_value IS NULL OR s.id=supplier_value)
      AND NOT EXISTS(SELECT 1 FROM regexp_split_to_table(search_value,' +') term
        WHERE term<>'' AND position(term IN public.egress_normalize_catalog_text(concat_ws(' ',s.code,s.name,s.phone)))=0)
  ), movements AS (
    SELECT t.supplier_id,
      COALESCE(sum(t.amount_change) FILTER(WHERE t.transaction_date>=end_at),0) after_end,
      COALESCE(sum(t.amount_change) FILTER(WHERE t.transaction_date<end_at AND NOT (t.transaction_type='opening_balance' AND t.transaction_date=start_at)),0) period_net,
      COALESCE(sum(t.amount_change) FILTER(WHERE t.transaction_date<end_at AND t.amount_change>0 AND NOT (t.transaction_type='opening_balance' AND t.transaction_date=start_at)),0) debit,
      COALESCE(-sum(t.amount_change) FILTER(WHERE t.transaction_date<end_at AND t.amount_change<0 AND NOT (t.transaction_type='opening_balance' AND t.transaction_date=start_at)),0) credit
    FROM public.supplier_debt_transactions t JOIN candidates c ON c.id=t.supplier_id
    WHERE t.transaction_date>=start_at GROUP BY t.supplier_id
  ), balances AS (
    SELECT c.id,c.code,c.name,c.debt-COALESCE(m.after_end,0)-COALESCE(m.period_net,0) opening,
      COALESCE(m.debit,0) debit,COALESCE(m.credit,0) credit,c.debt-COALESCE(m.after_end,0) closing
    FROM candidates c LEFT JOIN movements m ON m.supplier_id=c.id
  ), filtered AS MATERIALIZED (
    SELECT * FROM balances b WHERE (min_value IS NULL OR closing>=min_value) AND (max_value IS NULL OR closing<=max_value)
      AND CASE status_value WHEN 'payable' THEN closing>0 WHEN 'advance' THEN closing<0 WHEN 'settled' THEN closing=0
        WHEN 'activity' THEN opening<>0 OR closing<>0 OR debit<>0 OR credit<>0 ELSE true END
  ), page AS (
    SELECT * FROM filtered ORDER BY closing DESC,code,id OFFSET page_offset LIMIT page_limit
  ) SELECT jsonb_build_object('from',start_day,'to',end_day,'generatedAt',now(),'cutoff',boundary,
    'rows',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.closing DESC,p.code,p.id) FROM page p),'[]'::jsonb),
    'total',count(*),'totals',jsonb_build_object('opening',COALESCE(sum(opening),0),'debit',COALESCE(sum(debit),0),'credit',COALESCE(sum(credit),0),'closing',COALESCE(sum(closing),0)),
    'fingerprint',md5(COALESCE(string_agg(id||':'||opening||':'||debit||':'||credit||':'||closing||':'||code||':'||name,'|' ORDER BY id),'')))
    INTO result_value FROM filtered;
  RETURN result_value;
END $$;
REVOKE ALL ON FUNCTION public.rpc_supplier_debt_report(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_supplier_debt_report(jsonb) TO authenticated;
ALTER FUNCTION public.rpc_supplier_debt_report(jsonb) SET statement_timeout='10s';
INSERT INTO public.schema_migrations(version,description) VALUES('0128','Finance-only supplier debt reports by period with reversals, carry balances, bounded pages and full filtered totals') ON CONFLICT(version) DO NOTHING;
NOTIFY pgrst,'reload schema';
COMMIT;
