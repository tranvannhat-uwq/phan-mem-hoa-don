-- Run only on an isolated Supabase staging database after migration 0084.
-- The fixture and its deliberate failed cancellation are rolled back.
BEGIN;

INSERT INTO public.customers(id, code, name, debt, total_transaction,
  net_revenue, status)
VALUES ('p84-customer', 'P84-CUSTOMER', 'P84 Customer', 130, 150, 150, 'active');

INSERT INTO public.orders(id, customer_id, customer_name, items,
  total_payable, total_amount, debt_amount, paid_amount, net_revenue,
  status, order_date, created_at)
VALUES ('P84-ORDER', 'p84-customer', 'P84 Customer', '[]'::jsonb,
  150, 150, 150, 0, 150, 'settled', now(), now());

INSERT INTO public.customer_debt_transactions(id, customer_id,
  transaction_type, amount, debt_change, balance_before, balance_after,
  order_id, description, transaction_date)
VALUES
  ('P84-CHARGE', 'p84-customer', 'order', 100, 100,
    0, 100, 'P84-ORDER', 'Original charge', now()),
  ('P84-AMEND', 'p84-customer', 'order_amend', 50, 50,
    100, 150, 'P84-ORDER', 'Amendment', now()),
  ('P84-RECEIPT', 'p84-customer', 'payment', 20, -20,
    150, 130, 'P84-ORDER', 'Independent linked receipt', now());

SET CONSTRAINTS p84_guard_cancelled_order_debt IMMEDIATE;
DO $assert$
DECLARE
  blocked boolean := false;
BEGIN
  BEGIN
    UPDATE public.orders SET status = 'cancelled' WHERE id = 'P84-ORDER';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'Không thể hủy đơn P84-ORDER:%150' THEN
      blocked := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT blocked THEN
    RAISE EXCEPTION '0084 failed to reject an incomplete order reversal';
  END IF;
END;
$assert$;

INSERT INTO public.customer_debt_transactions(id, customer_id,
  transaction_type, amount, debt_change, balance_before, balance_after,
  order_id, description, transaction_date)
VALUES ('P84-VOID', 'p84-customer', 'order_cancel', 150, -150,
  130, -20, 'P84-ORDER', 'Complete reversal', now());
UPDATE public.customers SET debt = -20 WHERE id = 'p84-customer';
UPDATE public.orders SET status = 'cancelled' WHERE id = 'P84-ORDER';
SET CONSTRAINTS ALL IMMEDIATE;

DO $assert$
BEGIN
  IF (SELECT status FROM public.orders WHERE id = 'P84-ORDER') <> 'cancelled'
     OR (SELECT debt FROM public.customers WHERE id = 'p84-customer') <> -20
     OR (SELECT debt_change FROM public.customer_debt_transactions
       WHERE id = 'P84-RECEIPT') <> -20 THEN
    RAISE EXCEPTION '0084 rejected a complete order reversal';
  END IF;
END;
$assert$;

SELECT '0084 cancellation debt guard passed' AS result;
ROLLBACK;
