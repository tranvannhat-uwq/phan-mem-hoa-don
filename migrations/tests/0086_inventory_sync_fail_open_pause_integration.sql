-- Run after migration 0086. Uses only a temporary table; no real order is
-- created. The foreign-key failure in the outbox simulates a queue outage.
begin;

create temporary table inventory_sync_fail_open_probe (
  id text primary key,
  items jsonb,
  status text,
  returned_amount numeric
);
create trigger inventory_sync_fail_open_probe_trigger
  after insert on inventory_sync_fail_open_probe
  for each row execute function private.queue_order_for_inventory_sync();

insert into inventory_sync_fail_open_probe(id, items, status, returned_amount)
values (gen_random_uuid()::text, '[]'::jsonb, 'settled', 0);

do $assert$
begin
  if (select count(*) from inventory_sync_fail_open_probe) <> 1 then
    raise exception 'Queue failure rolled back the source write';
  end if;
  if exists (select 1 from public.inventory_sync_outbox o
             join inventory_sync_fail_open_probe p on p.id = o.order_id) then
    raise exception 'Foreign key unexpectedly accepted the probe order';
  end if;
end;
$assert$;

select '0086 checkout fail-open passed' as result;
rollback;
