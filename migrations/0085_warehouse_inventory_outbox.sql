-- New finalized orders are queued for the separate warehouse application.
-- Existing orders are deliberately not backfilled: their stock may already
-- have been accounted for manually.
create extension if not exists pg_net;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.inventory_sync_settings (
  id boolean primary key default true check (id),
  endpoint text not null check (endpoint ~ '^https://'),
  signing_secret text not null check (length(signing_secret) >= 32)
);
revoke all on private.inventory_sync_settings from public, anon, authenticated, service_role;

create sequence if not exists public.inventory_sync_version_seq;
revoke all on sequence public.inventory_sync_version_seq from public, anon, authenticated;

create table if not exists public.inventory_sync_outbox (
  order_id text primary key references public.orders(id) on delete restrict,
  version bigint not null check (version > 0),
  pending boolean not null default true,
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  last_error text,
  queued_at timestamptz not null default now(),
  synced_at timestamptz
);
create index if not exists inventory_sync_outbox_pending_idx
  on public.inventory_sync_outbox(last_attempt_at, version) where pending;
alter table public.inventory_sync_outbox enable row level security;
revoke all on public.inventory_sync_outbox from public, anon, authenticated, service_role;
grant select on public.inventory_sync_outbox to service_role;

create or replace function public.ack_inventory_sync(
  p_order_id text,
  p_version bigint,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.inventory_sync_outbox
  set pending = (p_error is not null),
      attempts = attempts + 1,
      last_attempt_at = now(),
      last_error = left(p_error, 500),
      synced_at = case when p_error is null then now() else synced_at end
  where order_id = p_order_id and version = p_version;
  return found;
end;
$$;
revoke all on function public.ack_inventory_sync(text, bigint, text) from public, anon, authenticated;
grant execute on function public.ack_inventory_sync(text, bigint, text) to service_role;

-- The request queue of pg_net can expose headers to database roles. Send a
-- short-lived signature, never the signing secret or a service-role key.
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
  from private.inventory_sync_settings where id = true;
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
    -- A notification failure must not roll back the paid order. The outbox
    -- remains pending for the scheduled retry.
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
    -- Only orders created after activation participate automatically.
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
end;
$$;
revoke all on function private.queue_order_for_inventory_sync() from public, anon, authenticated;

drop trigger if exists queue_order_for_inventory_sync on public.orders;
create trigger queue_order_for_inventory_sync
  after insert or update of items, status, returned_amount on public.orders
  for each row execute function private.queue_order_for_inventory_sync();

-- A zero-priced return can change returned quantity without changing the
-- order's returned_amount or status. Queue that case from the item as well.
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
end;
$$;
revoke all on function private.queue_returned_item_for_inventory_sync() from public, anon, authenticated;

drop trigger if exists queue_returned_item_for_inventory_sync on public.order_items;
create trigger queue_returned_item_for_inventory_sync
  after update of returned_quantity on public.order_items
  for each row execute function private.queue_returned_item_for_inventory_sync();
