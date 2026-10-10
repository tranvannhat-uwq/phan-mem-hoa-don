-- Run on an isolated staging database after migration 0085. The transaction
-- rolls back the fixture, and pg_net sends no request from a rolled-back tx.
begin;

insert into public.orders(id, customer_name, items, status, order_date, created_at)
values ('P85-SYNC-ORDER', 'Integration Test', '[]'::jsonb, 'settled', now(), now());

do $assert$
begin
  if not exists (select 1 from public.inventory_sync_outbox
                 where order_id = 'P85-SYNC-ORDER' and pending) then
    raise exception 'New finalized order was not queued';
  end if;
end;
$assert$;

update public.orders set status = 'returned' where id = 'P85-SYNC-ORDER';

do $assert$
declare
  v_version bigint;
begin
  select version into v_version from public.inventory_sync_outbox
  where order_id = 'P85-SYNC-ORDER';
  if v_version <= 1 then
    raise exception 'Order change did not advance the sync version';
  end if;
  if public.ack_inventory_sync('P85-SYNC-ORDER', v_version - 1, null) then
    raise exception 'Stale acknowledgement was accepted';
  end if;
  if not public.ack_inventory_sync('P85-SYNC-ORDER', v_version, null) then
    raise exception 'Current acknowledgement was rejected';
  end if;
  if exists (select 1 from public.inventory_sync_outbox
             where order_id = 'P85-SYNC-ORDER' and pending) then
    raise exception 'Acknowledged order remained pending';
  end if;
end;
$assert$;

select '0085 inventory outbox passed' as result;
rollback;
