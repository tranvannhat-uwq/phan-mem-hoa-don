-- Read-only preview for the stale invoice-time incident on 16/09/2026.
-- The activity timestamp is the real insert time; order_date is the editable
-- business timestamp printed on the invoice. No data is changed by this file.

WITH created_events AS (
  SELECT DISTINCT ON (log.order_id)
    log.order_id,
    log.created_at AS actual_created_at,
    log.actor_name,
    log.actor_username
  FROM public.activity_logs log
  WHERE log.action = 'create_order'
    AND log.order_id IS NOT NULL
    AND log.created_at >= timestamptz '2026-09-16 12:00:00+07:00'
    AND log.created_at <  timestamptz '2026-09-17 00:00:00+07:00'
  ORDER BY log.order_id, log.created_at, log.id
)
SELECT
  sale.id,
  sale.customer_name,
  sale.status,
  sale.order_date AS current_invoice_time,
  event.actual_created_at AS proposed_invoice_time,
  round(extract(epoch FROM (event.actual_created_at - sale.order_date)) / 60, 1)
    AS lag_minutes,
  sale.created_at AS immutable_insert_time,
  event.actor_name,
  event.actor_username
FROM public.orders sale
JOIN created_events event ON event.order_id = sale.id
WHERE (sale.order_date AT TIME ZONE 'Asia/Bangkok')::date = date '2026-09-16'
  AND event.actual_created_at - sale.order_date >= interval '5 minutes'
  AND event.actual_created_at - sale.order_date < interval '12 hours'
  -- Both timestamps originate in the same insert transaction. This guard
  -- rejects bridged/ambiguous activity rows before any repair is considered.
  AND abs(extract(epoch FROM (event.actual_created_at - sale.created_at))) <= 120
ORDER BY event.actual_created_at, sale.id;
