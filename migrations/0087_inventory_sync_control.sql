-- Warehouse admins can read and pause the billing-side switch through the
-- billing service-role key. Neither function exposes the signing secret.
create or replace function public.inventory_sync_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'configured', exists (
      select 1 from private.inventory_sync_settings where id = true
    ),
    'enabled', coalesce((
      select enabled from private.inventory_sync_settings where id = true
    ), false)
  );
$$;
revoke all on function public.inventory_sync_status() from public, anon, authenticated;
grant execute on function public.inventory_sync_status() to service_role;

create or replace function public.pause_inventory_sync()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.inventory_sync_settings
  set enabled = false
  where id = true;
  return found;
end;
$$;
revoke all on function public.pause_inventory_sync() from public, anon, authenticated;
grant execute on function public.pause_inventory_sync() to service_role;
