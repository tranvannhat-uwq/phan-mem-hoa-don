-- Keep warehouse synchronization paused until products and opening stock have
-- been reconciled. Order checkout must succeed even if the sync queue fails.
alter table private.inventory_sync_settings
  add column if not exists enabled boolean not null default false;
update private.inventory_sync_settings set enabled = false where enabled;

create or replace function private.dispatch_inventory_sync()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_endpoint text;
  v_secret text;
  v_timestamp text;
  v_nonce text;
  v_signature text;
begin
  if not exists (select 1 from public.inventory_sync_outbox where pending) then
    return;
  end if;
  select endpoint, signing_secret into v_endpoint, v_secret
  from private.inventory_sync_settings where id = true and enabled = true;
  if v_endpoint is null or v_secret is null then
    return;
  end if;
  v_timestamp := floor(extract(epoch from clock_timestamp()))::bigint::text;
  v_nonce := gen_random_uuid()::text;
  v_signature := encode(pg_catalog.sha256(pg_catalog.convert_to(
    v_timestamp || ':' || v_nonce || ':' || v_secret, 'UTF8')), 'hex');
  begin
    perform net.http_post(
      url := v_endpoint,
      body := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Inventory-Timestamp', v_timestamp,
        'X-Inventory-Nonce', v_nonce,
        'X-Inventory-Signature', v_signature
      ),
      timeout_milliseconds := 10000
    );
  exception when others then
    raise warning 'Inventory sync notification failed: %', sqlerrm;
  end;
end;
$$;
revoke all on function private.dispatch_inventory_sync() from public, anon, authenticated;

create or replace function private.queue_order_for_inventory_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.items is not distinct from old.items
      and new.status is not distinct from old.status
      and new.returned_amount is not distinct from old.returned_amount then
      return new;
    end if;
    if not exists (select 1 from public.inventory_sync_outbox where order_id = new.id) then
      return new;
    end if;
  end if;
  insert into public.inventory_sync_outbox(order_id, version, pending, queued_at, last_error)
  values (new.id, nextval('public.inventory_sync_version_seq'), true, now(), null)
  on conflict (order_id) do update
    set version = excluded.version, pending = true, queued_at = now(),
        attempts = 0, last_attempt_at = null, last_error = null;
  perform private.dispatch_inventory_sync();
  return new;
exception when others then
  -- An integration failure must not roll back checkout or an order update.
  raise warning 'Inventory sync queue failed for order %: %', new.id, sqlerrm;
  return new;
end;
$$;
revoke all on function private.queue_order_for_inventory_sync() from public, anon, authenticated;

create or replace function private.queue_returned_item_for_inventory_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.returned_quantity is distinct from old.returned_quantity
    and exists (select 1 from public.inventory_sync_outbox where order_id = new.order_id) then
    update public.inventory_sync_outbox
    set version = nextval('public.inventory_sync_version_seq'),
        pending = true, queued_at = now(), attempts = 0,
        last_attempt_at = null, last_error = null
    where order_id = new.order_id;
    perform private.dispatch_inventory_sync();
  end if;
  return new;
exception when others then
  raise warning 'Inventory sync queue failed for returned item in order %: %', new.order_id, sqlerrm;
  return new;
end;
$$;
revoke all on function private.queue_returned_item_for_inventory_sync() from public, anon, authenticated;
