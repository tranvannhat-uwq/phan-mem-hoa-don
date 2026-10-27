BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
-- Definitions only. No snapshot, maintenance change or purge is executed.
DO $guard$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.schema_migrations WHERE version='0120') THEN RAISE EXCEPTION '0121 requires 0120'; END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.rpc_prepare_monthly_retention(uuid,boolean)'::regprocedure
    AND md5(replace(prosrc,chr(13),''))='f6aaa9811c211a4b1d1617c2a154d0b0') THEN
    RAISE EXCEPTION '0121: unexpected recovery function';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_proc WHERE oid='public.rpc_execute_monthly_retention(uuid,text,text)'::regprocedure
    AND md5(replace(prosrc,chr(13),''))='c12faec5ad9ab9d193d0ba01d37d1182') THEN
    RAISE EXCEPTION '0121: unexpected purge function';
  END IF;
END $guard$;

-- Short-lived private transport copies, excluded from application snapshots.
CREATE TABLE public.retention_backup_sessions (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL, epoch bigint NOT NULL, cutoff timestamptz NOT NULL,
  fingerprint text NOT NULL, table_hashes jsonb NOT NULL, tables text[] NOT NULL,
  header jsonb NOT NULL, preview jsonb NOT NULL, staged jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  ready boolean NOT NULL DEFAULT false
);
CREATE TABLE public.retention_backup_parts (
  session_id uuid NOT NULL REFERENCES public.retention_backup_sessions(id) ON DELETE CASCADE,
  table_name text NOT NULL, part_no integer NOT NULL CHECK(part_no>=0),
  body text NOT NULL CHECK(octet_length(body)<=262144), sha256 text NOT NULL,
  PRIMARY KEY(session_id,table_name,part_no)
);
ALTER TABLE public.retention_backup_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retention_backup_parts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.retention_backup_sessions,public.retention_backup_parts FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.p121_table_hash(p_table text) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result text;
BEGIN
  IF NOT p_table=ANY(public.p107_snapshot_tables(false)) THEN RAISE EXCEPTION 'Invalid snapshot table'; END IF;
  EXECUTE format('SELECT encode(sha256(convert_to(COALESCE(string_agg(h,'''' ORDER BY h),''''),''UTF8'')),''hex'')
    FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,''UTF8'')),''hex'') h FROM public.%I t) r',p_table) INTO result;
  RETURN result;
END $$;

CREATE FUNCTION public.p121_columns(p_tables text[]) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT COALESCE(jsonb_object_agg(t.name,(SELECT jsonb_agg(column_name ORDER BY ordinal_position)
    FROM information_schema.columns WHERE table_schema='public' AND table_name=t.name)),'{}')
  FROM unnest(p_tables) t(name)
$$;

CREATE FUNCTION public.p121_session(p_id uuid) RETURNS public.retention_backup_sessions
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE; s public.retention_backup_sessions%ROWTYPE;
BEGIN
  actor:=public.p107_require_admin();
  PERFORM public.p107_assert_epoch();
  SELECT * INTO s FROM public.retention_backup_sessions WHERE id=p_id AND actor_id=actor.auth_user_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'Không tìm thấy lần sao lưu của tài khoản này.' USING ERRCODE='42501'; END IF;
  IF s.expires_at<now() OR s.cutoff<>public.p107_cutoff() OR s.epoch<>(SELECT epoch FROM public.retention_control WHERE id) THEN
    RAISE EXCEPTION 'Lần sao lưu đã hết hạn hoặc kỳ dữ liệu đã đổi. Hãy kiểm tra phạm vi và tạo lại.';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.system_maintenance WHERE id AND enabled) THEN
    RAISE EXCEPTION 'Hãy giữ chế độ bảo trì trong lúc tạo và tải bản sao.';
  END IF;
  RETURN s;
END $$;

CREATE FUNCTION public.rpc_start_retention_backup(p_request_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='60s' AS $$
DECLARE actor public.profiles%ROWTYPE; s public.retention_backup_sessions%ROWTYPE; preview jsonb;
  tables text[]; target text; hashes jsonb:='{}'; pieces text:=''; part text; seq record; sequences jsonb:='{}'; value jsonb;
BEGIN
  actor:=public.p107_require_admin();
  IF p_request_key IS NULL THEN RAISE EXCEPTION 'Thiếu mã yêu cầu.'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.system_maintenance WHERE id AND enabled) THEN RAISE EXCEPTION 'Hãy bật bảo trì trước khi tạo bản sao.'; END IF;
  PERFORM set_config('lock_timeout','3s',true);
  PERFORM public.p107_lock_scope(false);
  DELETE FROM public.retention_backup_sessions WHERE expires_at<now();
  SELECT * INTO s FROM public.retention_backup_sessions WHERE id=p_request_key;
  IF FOUND THEN
    s:=public.p121_session(p_request_key);
    RETURN jsonb_build_object('id',s.id,'tables',s.tables,'staged',s.staged,'ready',s.ready);
  END IF;
  IF EXISTS(SELECT 1 FROM public.retention_jobs WHERE id=p_request_key) THEN RAISE EXCEPTION 'Mã sao lưu đã được sử dụng. Hãy kiểm tra phạm vi và tạo lại.'; END IF;
  -- A new explicit preparation replaces this actor's older transport copies.
  DELETE FROM public.retention_backup_sessions WHERE actor_id=actor.auth_user_id;
  preview:=public.p107_preview(false);
  IF NOT (preview->>'can_prepare')::boolean THEN RAISE EXCEPTION 'Chưa thể dọn: %',preview->'blockers'; END IF;
  tables:=public.p107_snapshot_tables(false);
  FOREACH target IN ARRAY tables LOOP
    part:=public.p121_table_hash(target); hashes:=hashes||jsonb_build_object(target,part);
    pieces:=pieces||target||':'||part||';';
  END LOOP;
  FOR seq IN SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename LOOP
    EXECUTE format('SELECT jsonb_build_object(''last_value'',last_value,''is_called'',is_called) FROM public.%I',seq.sequencename) INTO value;
    sequences:=sequences||jsonb_build_object(seq.sequencename,value);
  END LOOP;
  s.fingerprint:=encode(sha256(convert_to(pieces,'UTF8')),'hex');
  INSERT INTO public.retention_backup_sessions(id,actor_id,epoch,cutoff,fingerprint,table_hashes,tables,preview,expires_at,header)
  VALUES(p_request_key,actor.auth_user_id,(preview->>'epoch')::bigint,(preview->>'cutoff')::timestamptz,s.fingerprint,hashes,tables,preview,now()+interval '30 minutes',
    jsonb_build_object('format','soviet-retention-recovery-v1','job_id',p_request_key,'created_at',now(),'cutoff',preview->'cutoff',
      'epoch',preview->'epoch','fingerprint',s.fingerprint,'schema_versions',(SELECT jsonb_agg(version ORDER BY version) FROM public.schema_migrations),
      'columns',public.p121_columns(tables),'sequences',sequences,
      'scope','Application recovery bundle. Auth users, secrets and project configuration are not included. Restore only into isolated staging with matching schema.'));
  PERFORM set_config('response.headers','[{"Cache-Control":"no-store"}]',true);
  RETURN jsonb_build_object('id',p_request_key,'tables',tables,'staged','{}'::jsonb,'ready',false);
END $$;

-- Append at most 64 Ki characters per stored part (at most 256 KiB UTF-8).
CREATE FUNCTION public.p121_push(p_id uuid,p_table text,p_piece text,INOUT buffer text,INOUT next_part integer,INOUT bytes bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE chunk text;
BEGIN
  buffer:=buffer||p_piece;
  WHILE length(buffer)>=65536 LOOP
    chunk:=left(buffer,65536); buffer:=substr(buffer,65537);
    bytes:=bytes+octet_length(chunk);
    IF bytes>268435456 THEN RAISE EXCEPTION 'Bản sao vượt 256 MB; cần sao lưu qua quản trị database.'; END IF;
    INSERT INTO public.retention_backup_parts VALUES(p_id,p_table,next_part,chunk,encode(sha256(convert_to(chunk,'UTF8')),'hex'));
    next_part:=next_part+1;
  END LOOP;
END $$;

CREATE FUNCTION public.rpc_stage_retention_backup_table(p_id uuid,p_table text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='60s' AS $$
DECLARE s public.retention_backup_sessions%ROWTYPE; buffer text:='['; next_part integer:=0; bytes bigint:=0; row_text text; first_row boolean:=true;
BEGIN
  PERFORM public.p107_require_admin();
  PERFORM set_config('lock_timeout','3s',true);
  PERFORM public.p107_lock_scope(false);
  s:=public.p121_session(p_id);
  IF p_table IS NULL OR NOT p_table=ANY(s.tables) THEN RAISE EXCEPTION 'Invalid snapshot table'; END IF;
  IF s.staged ? p_table THEN RETURN s.staged->p_table; END IF;
  IF s.ready THEN RAISE EXCEPTION 'Bản sao đã được hoàn tất.'; END IF;
  IF public.p121_table_hash(p_table) IS DISTINCT FROM s.table_hashes->>p_table
    OR public.p121_columns(ARRAY[p_table])->p_table IS DISTINCT FROM s.header->'columns'->p_table THEN
    RAISE EXCEPTION 'Dữ liệu đã thay đổi trong lúc sao lưu. Hãy kiểm tra phạm vi và tạo lại.' USING ERRCODE='40001';
  END IF;
  FOR row_text IN EXECUTE format('SELECT to_jsonb(t)::text FROM public.%I t ORDER BY md5(to_jsonb(t)::text),to_jsonb(t)::text COLLATE "C"',p_table) LOOP
    SELECT * INTO buffer,next_part,bytes FROM public.p121_push(p_id,p_table,(CASE WHEN first_row THEN '' ELSE ', ' END)||row_text,buffer,next_part,bytes);
    first_row:=false;
  END LOOP;
  buffer:=buffer||']'; bytes:=bytes+octet_length(buffer);
  IF bytes+(SELECT COALESCE(sum((v->>'bytes')::bigint),0) FROM jsonb_each(s.staged) e(k,v))>268435456 THEN
    RAISE EXCEPTION 'Bản sao vượt 256 MB; cần sao lưu qua quản trị database.';
  END IF;
  INSERT INTO public.retention_backup_parts VALUES(p_id,p_table,next_part,buffer,encode(sha256(convert_to(buffer,'UTF8')),'hex'));
  UPDATE public.retention_backup_sessions SET staged=staged||jsonb_build_object(p_table,jsonb_build_object('parts',next_part+1,'bytes',bytes)) WHERE id=p_id;
  RETURN jsonb_build_object('parts',next_part+1,'bytes',bytes);
END $$;

-- All callers use this exact textual plan, including canonical JSON spacing.
CREATE FUNCTION public.p121_download_plan(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE s public.retention_backup_sessions%ROWTYPE; entry record; target text; plan jsonb:='[{"text":"{"}]'; prefix text:=''; table_prefix text;
BEGIN
  SELECT * INTO STRICT s FROM public.retention_backup_sessions WHERE id=p_id;
  FOR entry IN SELECT key,value FROM jsonb_each(s.header||'{"tables":null}'::jsonb) ORDER BY octet_length(key),key COLLATE "C" LOOP
    plan:=plan||jsonb_build_array(jsonb_build_object('text',prefix||to_jsonb(entry.key)::text||': ')); prefix:=', ';
    IF entry.key='tables' THEN
      plan:=plan||jsonb_build_array(jsonb_build_object('text','{')); table_prefix:='';
      FOR target IN SELECT name FROM unnest(s.tables) t(name) ORDER BY octet_length(name),name COLLATE "C" LOOP
        plan:=plan||jsonb_build_array(jsonb_build_object('text',table_prefix||to_jsonb(target)::text||': '),
          jsonb_build_object('table',target,'parts',(s.staged->target->>'parts')::integer,'bytes',(s.staged->target->>'bytes')::bigint));
        table_prefix:=', ';
      END LOOP;
      plan:=plan||jsonb_build_array(jsonb_build_object('text','}'));
    ELSE plan:=plan||jsonb_build_array(jsonb_build_object('text',entry.value::text)); END IF;
  END LOOP;
  RETURN plan||jsonb_build_array(jsonb_build_object('text','}'));
END $$;

CREATE FUNCTION public.rpc_finish_retention_backup(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='60s' AS $$
DECLARE s public.retention_backup_sessions%ROWTYPE; j public.retention_jobs%ROWTYPE; plan jsonb; raw_text text; checksum text; bytes bigint;
BEGIN
  PERFORM public.p107_require_admin(); PERFORM set_config('lock_timeout','3s',true); PERFORM public.p107_lock_scope(false);
  s:=public.p121_session(p_id);
  IF NOT s.ready THEN
    IF EXISTS(SELECT 1 FROM unnest(s.tables) t(name) WHERE NOT s.staged ? name) THEN RAISE EXCEPTION 'Chưa chuẩn bị đủ dữ liệu sao lưu.'; END IF;
    IF s.tables IS DISTINCT FROM public.p107_snapshot_tables(false)
      OR s.header->'columns' IS DISTINCT FROM public.p121_columns(s.tables)
      OR s.header->'schema_versions' IS DISTINCT FROM (SELECT jsonb_agg(version ORDER BY version) FROM public.schema_migrations)
      OR public.p107_fingerprint(false) IS DISTINCT FROM s.fingerprint THEN
      RAISE EXCEPTION 'Dữ liệu đã thay đổi trong lúc sao lưu. Hãy kiểm tra phạm vi và tạo lại.' USING ERRCODE='40001';
    END IF;
    plan:=public.p121_download_plan(p_id);
    SELECT string_agg(body,'' ORDER BY piece_no,part_no) INTO raw_text
      FROM jsonb_array_elements(plan) WITH ORDINALITY e(piece,piece_no)
      CROSS JOIN LATERAL (
        SELECT -1 part_no,piece->>'text' body WHERE piece ? 'text'
        UNION ALL SELECT p.part_no,p.body FROM public.retention_backup_parts p WHERE p.session_id=p_id AND p.table_name=piece->>'table'
      ) pieces;
    bytes:=octet_length(raw_text);
    IF bytes>268435456 THEN RAISE EXCEPTION 'Bản sao vượt 256 MB; cần sao lưu qua quản trị database.'; END IF;
    checksum:=encode(sha256(convert_to(raw_text,'UTF8')),'hex'); raw_text:=NULL;
    INSERT INTO public.retention_jobs(id,actor_id,cutoff,include_archive,epoch_before,state,fingerprint,backup_sha256,preview,created_at,expires_at)
      VALUES(p_id,s.actor_id,s.cutoff,false,s.epoch,'prepared',s.fingerprint,checksum,s.preview,s.created_at,s.expires_at);
    UPDATE public.retention_backup_sessions SET ready=true WHERE id=p_id;
  END IF;
  SELECT * INTO STRICT j FROM public.retention_jobs WHERE id=p_id AND actor_id=s.actor_id;
  IF j.state<>'prepared' THEN RAISE EXCEPTION 'Lần dọn này đã được xử lý.'; END IF;
  PERFORM set_config('response.headers','[{"Cache-Control":"no-store"}]',true);
  RETURN jsonb_build_object('job_id',j.id,'backup_sha256',j.backup_sha256,'preview',j.preview,'expires_at',j.expires_at,'plan',public.p121_download_plan(p_id));
END $$;

CREATE FUNCTION public.rpc_retention_backup_parts(p_id uuid,p_table text,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public SET statement_timeout='15s' AS $$
DECLARE s public.retention_backup_sessions%ROWTYPE;
BEGIN
  s:=public.p121_session(p_id);
  IF NOT s.ready OR p_table IS NULL OR NOT p_table=ANY(s.tables) OR p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Yêu cầu tải bản sao không hợp lệ.'; END IF;
  PERFORM set_config('response.headers','[{"Cache-Control":"no-store"}]',true);
  RETURN (SELECT COALESCE(jsonb_agg(jsonb_build_object('part',part_no,'text',body,'sha256',sha256) ORDER BY part_no),'[]')
    FROM (SELECT part_no,body,sha256 FROM public.retention_backup_parts WHERE session_id=p_id AND table_name=p_table AND part_no>=p_offset ORDER BY part_no LIMIT 4) p);
END $$;

CREATE FUNCTION public.rpc_release_retention_backup(p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.profiles%ROWTYPE;
BEGIN
  actor:=public.p107_require_admin();
  PERFORM pg_advisory_xact_lock(hashtextextended('billing-monthly-retention',0));
  DELETE FROM public.retention_backup_sessions WHERE id=p_id AND actor_id=actor.auth_user_id;
  RETURN FOUND;
END $$;

-- Successful purge cannot leave private transport copies of removed history.
DO $patch$
DECLARE original text; anchor text:='RETURN result_payload;';
BEGIN
  SELECT pg_get_functiondef('public.rpc_execute_monthly_retention(uuid,text,text)'::regprocedure) INTO original;
  IF strpos(original,anchor)=0 OR strpos(original,'public.p118_assert_kept')=0 THEN RAISE EXCEPTION '0121: unexpected purge contract'; END IF;
  EXECUTE replace(original,anchor,'DELETE FROM public.retention_backup_sessions; '||anchor);
END $patch$;

REVOKE ALL ON FUNCTION public.p121_table_hash(text),public.p121_columns(text[]),public.p121_session(uuid),
  public.p121_push(uuid,text,text,text,integer,bigint),public.p121_download_plan(uuid),
  public.rpc_start_retention_backup(uuid),public.rpc_stage_retention_backup_table(uuid,text),public.rpc_finish_retention_backup(uuid),
  public.rpc_retention_backup_parts(uuid,text,integer),public.rpc_release_retention_backup(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_start_retention_backup(uuid),public.rpc_stage_retention_backup_table(uuid,text),
  public.rpc_finish_retention_backup(uuid),public.rpc_retention_backup_parts(uuid,text,integer),public.rpc_release_retention_backup(uuid) TO authenticated;
INSERT INTO public.schema_migrations(version,description) VALUES ('0121','Stage consistent recovery tables separately and download bounded private chunks');
NOTIFY pgrst,'reload schema';
COMMIT;
