BEGIN;

-- Activity Log access is reserved for Admin. The order-level reader uses the
-- same rule so the per-order timeline cannot bypass the global Activity Log.
CREATE OR REPLACE FUNCTION public.rpc_get_activity_logs(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  page_limit integer;
  page_offset integer;
  result jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role <> 'admin' THEN
    RAISE EXCEPTION '403: activity log access denied' USING ERRCODE='42501';
  END IF;

  page_limit := LEAST(GREATEST(COALESCE((p_filters->>'limit')::integer,25),1),100);
  page_offset := GREATEST(COALESCE((p_filters->>'offset')::integer,0),0);
  WITH filtered AS (
    SELECT log.*
    FROM public.activity_logs log
    WHERE log.created_at >= now() - interval '4 days'
      AND (NULLIF(p_filters->>'search','') IS NULL OR concat_ws(' ',log.target_id,log.target_name,log.actor_name,log.actor_username,log.order_id,log.customer_id) ILIKE ('%' || (p_filters->>'search') || '%'))
      AND (NULLIF(p_filters->>'actor_id','') IS NULL OR p_filters->>'actor_id'='all' OR log.actor_id::text=p_filters->>'actor_id' OR log.actor_profile_id=p_filters->>'actor_id')
      AND (NULLIF(p_filters->>'module','') IS NULL OR p_filters->>'module'='all' OR log.module=p_filters->>'module')
      AND (NULLIF(p_filters->>'action','') IS NULL OR p_filters->>'action'='all' OR log.action=p_filters->>'action')
      AND (NULLIF(p_filters->>'order_id','') IS NULL OR log.order_id=p_filters->>'order_id')
      AND (NULLIF(p_filters->>'customer_id','') IS NULL OR log.customer_id=p_filters->>'customer_id')
      AND (NULLIF(p_filters->>'start','') IS NULL OR log.created_at >= (p_filters->>'start')::timestamptz)
      AND (NULLIF(p_filters->>'end','') IS NULL OR log.created_at < (p_filters->>'end')::timestamptz)
  ), page AS (
    SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT page_limit OFFSET page_offset
  )
  SELECT jsonb_build_object(
    'rows',COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb),
    'total',(SELECT count(*) FROM filtered),'limit',page_limit,'offset',page_offset
  ) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_order_activity(p_order_id text, p_limit integer DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  result jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role <> 'admin' THEN
    RAISE EXCEPTION '403: activity log access denied' USING ERRCODE='42501';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(log) ORDER BY log.created_at DESC,log.id DESC),'[]'::jsonb)
  INTO result
  FROM (
    SELECT * FROM public.activity_logs
    WHERE order_id=p_order_id AND created_at >= now() - interval '4 days'
    ORDER BY created_at DESC,id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit,50),1),100)
  ) log;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_activity_logs(jsonb), public.rpc_get_order_activity(text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_activity_logs(jsonb), public.rpc_get_order_activity(text,integer) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0076', 'Restrict Activity Log readers to Admin')
ON CONFLICT (version) DO NOTHING;

COMMIT;
