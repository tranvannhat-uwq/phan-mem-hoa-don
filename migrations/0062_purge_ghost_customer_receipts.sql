BEGIN;

-- Migration 0062: Purge ghost duplicate TTM receipts in cashbook_transactions
-- In earlier versions, creating a customer receipt from the cashbook modal could
-- inadvertently insert a temporary TTM voucher alongside the official PT- voucher.
-- We cancel any such phantom TTM vouchers that duplicate an active PT- customer receipt.

UPDATE public.cashbook_transactions
SET status = 'Đã hủy',
    cancellation_reason = 'Hủy phiếu trùng lặp mã TTM do lỗi hiển thị trước đó'
WHERE id ~* '^TTM\d+$'
  AND status <> 'Đã hủy'
  AND EXISTS (
    SELECT 1 FROM public.cashbook_transactions pt
    WHERE pt.id ~* '^PT-'
      AND pt.type = 'thu'
      AND pt.status = 'completed'
      AND lower(btrim(pt.partner)) = lower(btrim(cashbook_transactions.partner))
      AND round(pt.value) = round(cashbook_transactions.value)
      AND abs(extract(epoch from (pt.date - cashbook_transactions.date))) < 1800
  );

INSERT INTO public.schema_migrations(version, description)
VALUES ('0062', 'Purge ghost duplicate TTM receipts in cashbook')
ON CONFLICT (version) DO NOTHING;

COMMIT;
