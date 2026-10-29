BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';

-- Monitoring is separate from financial data and monthly document retention.
-- Only the latest database snapshot is kept; no query text or personal data.
CREATE TABLE private.app_system_status (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), sampled_at timestamptz,
 database_bytes bigint, connections integer, max_connections integer, waiting_locks integer
);
INSERT INTO private.app_system_status(id) VALUES(true);
CREATE TABLE private.app_egress_totals (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), started_at timestamptz NOT NULL DEFAULT now(),
 measured_bytes bigint NOT NULL DEFAULT 0, requests bigint NOT NULL DEFAULT 0,
 truncated_responses bigint NOT NULL DEFAULT 0, reported_at timestamptz
);
INSERT INTO private.app_egress_totals(id) VALUES(true);
-- Short-lived cumulative acknowledgements make retries/out-of-order uploads
-- idempotent. There are no routes, URLs, customer IDs or response bodies here.
CREATE TABLE private.app_egress_sessions (
 report_day date NOT NULL, actor_id uuid NOT NULL, session_id uuid NOT NULL,
 measured_bytes bigint NOT NULL, requests bigint NOT NULL, truncated_responses bigint NOT NULL,
 PRIMARY KEY(report_day,actor_id,session_id)
);
ALTER TABLE private.app_system_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.app_egress_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.app_egress_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.app_system_status,private.app_egress_totals,private.app_egress_sessions FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.capture_app_system_status(p_force boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE previous timestamptz;
BEGIN
 IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('app_system_status_capture')) THEN RETURN; END IF;
 SELECT sampled_at INTO previous FROM private.app_system_status WHERE id;
 IF NOT p_force AND previous>clock_timestamp()-interval '2 hours' THEN RETURN; END IF;
 UPDATE private.app_system_status SET sampled_at=clock_timestamp(),
   database_bytes=pg_catalog.pg_database_size(current_database()),
   connections=(SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()),
   max_connections=current_setting('max_connections')::integer,
   waiting_locks=(SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock') WHERE id;
END $$;
REVOKE ALL ON FUNCTION private.capture_app_system_status(boolean) FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.rpc_report_application_egress(p_report jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
<<egress_report>>
DECLARE actor public.profiles; report_day date; session_key uuid; old private.app_egress_sessions;
 bytes bigint; requests bigint; truncated bigint; today date:=(now() AT TIME ZONE 'Asia/Bangkok')::date;
BEGIN
 actor:=public.require_authenticated_profile();
 IF jsonb_typeof(p_report) IS DISTINCT FROM 'object' OR octet_length(p_report::text)>1024 THEN RAISE EXCEPTION 'Báo cáo lưu lượng không hợp lệ.'; END IF;
 IF (p_report->>'actorId')::uuid IS DISTINCT FROM actor.auth_user_id THEN RAISE EXCEPTION 'Không được gửi số liệu cho tài khoản khác.' USING ERRCODE='42501'; END IF;
 report_day:=(p_report->>'day')::date; session_key:=(p_report->>'sessionId')::uuid;
 bytes:=(p_report->>'bytes')::bigint; requests:=(p_report->>'requests')::bigint; truncated:=(p_report->>'truncated')::bigint;
 IF report_day IS NULL OR report_day NOT BETWEEN today-1 AND today OR session_key IS NULL
   OR bytes IS NULL OR bytes NOT BETWEEN 0 AND 1000000000000
   OR requests IS NULL OR requests NOT BETWEEN 0 AND 100000000
   OR truncated IS NULL OR truncated NOT BETWEEN 0 AND requests THEN RAISE EXCEPTION 'Báo cáo lưu lượng không hợp lệ.'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(actor.auth_user_id::text),pg_catalog.hashtext(report_day::text));
 SELECT * INTO old FROM private.app_egress_sessions s WHERE s.report_day=egress_report.report_day AND s.actor_id=actor.auth_user_id AND s.session_id=session_key;
 IF NOT FOUND AND (SELECT count(*) FROM private.app_egress_sessions s WHERE s.report_day=egress_report.report_day AND s.actor_id=actor.auth_user_id)>=32 THEN
   RAISE EXCEPTION 'Đã đạt giới hạn phiên theo dõi lưu lượng trong ngày.';
 END IF;
 INSERT INTO private.app_egress_sessions VALUES(report_day,actor.auth_user_id,session_key,bytes,requests,truncated)
 ON CONFLICT ON CONSTRAINT app_egress_sessions_pkey DO UPDATE SET
  measured_bytes=GREATEST(app_egress_sessions.measured_bytes,EXCLUDED.measured_bytes),
  requests=GREATEST(app_egress_sessions.requests,EXCLUDED.requests),
  truncated_responses=GREATEST(app_egress_sessions.truncated_responses,EXCLUDED.truncated_responses);
 UPDATE private.app_egress_totals SET measured_bytes=measured_bytes+GREATEST(bytes-COALESCE(old.measured_bytes,0),0),
   requests=app_egress_totals.requests+GREATEST(egress_report.requests-COALESCE(old.requests,0),0),
   truncated_responses=truncated_responses+GREATEST(truncated-COALESCE(old.truncated_responses,0),0),reported_at=clock_timestamp() WHERE id;
 DELETE FROM private.app_egress_sessions s WHERE s.report_day<today-2;
 RETURN '{"accepted":true}'::jsonb;
END $$;

CREATE FUNCTION public.rpc_admin_system_status(p_refresh boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor public.profiles; previous timestamptz;
BEGIN
 actor:=public.require_authenticated_profile();
 IF actor.role<>'admin' THEN RAISE EXCEPTION 'Chỉ Admin được xem tình trạng hệ thống.' USING ERRCODE='42501'; END IF;
 SELECT sampled_at INTO previous FROM private.app_system_status WHERE id;
 -- Shared cooldown prevents repeated manual clicks from becoming load.
 PERFORM private.capture_app_system_status(COALESCE(p_refresh,false) AND (previous IS NULL OR previous<clock_timestamp()-interval '30 seconds'));
 RETURN (SELECT jsonb_build_object('sampledAt',s.sampled_at,'databaseBytes',s.database_bytes,
   'connections',s.connections,'maxConnections',s.max_connections,'waitingLocks',s.waiting_locks,
   'egressBytes',CASE WHEN e.reported_at IS NOT NULL THEN e.measured_bytes END,
   'egressSince',e.started_at,'egressReportedAt',e.reported_at,'updateEveryHours',2,
   'egressSource','application_http_estimate') FROM private.app_system_status s CROSS JOIN private.app_egress_totals e WHERE s.id AND e.id);
END $$;
REVOKE ALL ON FUNCTION public.rpc_report_application_egress(jsonb),public.rpc_admin_system_status(boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_report_application_egress(jsonb),public.rpc_admin_system_status(boolean) TO authenticated;

SELECT private.capture_app_system_status(true);
DO $cron$
BEGIN
 IF to_regprocedure('cron.schedule(text,text,text)') IS NOT NULL THEN
   IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='app-system-status-2h') THEN RAISE EXCEPTION 'Monitoring job name already exists; review before replacing it.'; END IF;
   PERFORM cron.schedule('app-system-status-2h','0 */2 * * *','SELECT private.capture_app_system_status(true);');
 END IF;
END $cron$;
INSERT INTO public.schema_migrations(version,description) VALUES('0132','Admin latest-only database status and batched application egress estimates; two-hour refresh');
NOTIFY pgrst,'reload schema';
COMMIT;
