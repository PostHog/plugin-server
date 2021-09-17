--
-- PostgreSQL database dump
--

-- Dumped from database version 12.7
-- Dumped by pg_dump version 13.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: graphile_worker; Type: SCHEMA; Schema: -; Owner: posthog
--

CREATE SCHEMA graphile_worker;


ALTER SCHEMA graphile_worker OWNER TO posthog;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: jobs; Type: TABLE; Schema: graphile_worker; Owner: posthog
--

CREATE TABLE graphile_worker.jobs (
    id bigint NOT NULL,
    queue_name text DEFAULT (public.gen_random_uuid())::text,
    task_identifier text NOT NULL,
    payload json DEFAULT '{}'::json NOT NULL,
    priority integer DEFAULT 0 NOT NULL,
    run_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 25 NOT NULL,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    key text,
    locked_at timestamp with time zone,
    locked_by text,
    revision integer DEFAULT 0 NOT NULL,
    flags jsonb,
    CONSTRAINT jobs_key_check CHECK ((length(key) > 0))
);


ALTER TABLE graphile_worker.jobs OWNER TO posthog;

--
-- Name: add_job(text, json, text, timestamp with time zone, integer, text, integer, text[], text); Type: FUNCTION; Schema: graphile_worker; Owner: posthog
--

CREATE FUNCTION graphile_worker.add_job(identifier text, payload json DEFAULT NULL::json, queue_name text DEFAULT NULL::text, run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, max_attempts integer DEFAULT NULL::integer, job_key text DEFAULT NULL::text, priority integer DEFAULT NULL::integer, flags text[] DEFAULT NULL::text[], job_key_mode text DEFAULT 'replace'::text) RETURNS graphile_worker.jobs
    LANGUAGE plpgsql
    AS $$
declare
  v_job "graphile_worker".jobs;
begin
  -- Apply rationality checks
  if length(identifier) > 128 then
    raise exception 'Task identifier is too long (max length: 128).' using errcode = 'GWBID';
  end if;
  if queue_name is not null and length(queue_name) > 128 then
    raise exception 'Job queue name is too long (max length: 128).' using errcode = 'GWBQN';
  end if;
  if job_key is not null and length(job_key) > 512 then
    raise exception 'Job key is too long (max length: 512).' using errcode = 'GWBJK';
  end if;
  if max_attempts < 1 then
    raise exception 'Job maximum attempts must be at least 1.' using errcode = 'GWBMA';
  end if;
  if job_key is not null and (job_key_mode is null or job_key_mode in ('replace', 'preserve_run_at')) then
    -- Upsert job if existing job isn't locked, but in the case of locked
    -- existing job create a new job instead as it must have already started
    -- executing (i.e. it's world state is out of date, and the fact add_job
    -- has been called again implies there's new information that needs to be
    -- acted upon).
    insert into "graphile_worker".jobs (
      task_identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      values(
        identifier,
        coalesce(payload, '{}'::json),
        queue_name,
        coalesce(run_at, now()),
        coalesce(max_attempts, 25),
        job_key,
        coalesce(priority, 0),
        (
          select jsonb_object_agg(flag, true)
          from unnest(flags) as item(flag)
        )
      )
      on conflict (key) do update set
        task_identifier=excluded.task_identifier,
        payload=excluded.payload,
        queue_name=excluded.queue_name,
        max_attempts=excluded.max_attempts,
        run_at=(case
          when job_key_mode = 'preserve_run_at' and jobs.attempts = 0 then jobs.run_at
          else excluded.run_at
        end),
        priority=excluded.priority,
        revision=jobs.revision + 1,
        flags=excluded.flags,
        -- always reset error/retry state
        attempts=0,
        last_error=null
      where jobs.locked_at is null
      returning *
      into v_job;
    -- If upsert succeeded (insert or update), return early
    if not (v_job is null) then
      return v_job;
    end if;
    -- Upsert failed -> there must be an existing job that is locked. Remove
    -- existing key to allow a new one to be inserted, and prevent any
    -- subsequent retries of existing job by bumping attempts to the max
    -- allowed.
    update "graphile_worker".jobs
      set
        key = null,
        attempts = jobs.max_attempts
      where key = job_key;
  elsif job_key is not null and job_key_mode = 'unsafe_dedupe' then
    -- Insert job, but if one already exists then do nothing, even if the
    -- existing job has already started (and thus represents an out-of-date
    -- world state). This is dangerous because it means that whatever state
    -- change triggered this add_job may not be acted upon (since it happened
    -- after the existing job started executing, but no further job is being
    -- scheduled), but it is useful in very rare circumstances for
    -- de-duplication. If in doubt, DO NOT USE THIS.
    insert into "graphile_worker".jobs (
      task_identifier,
      payload,
      queue_name,
      run_at,
      max_attempts,
      key,
      priority,
      flags
    )
      values(
        identifier,
        coalesce(payload, '{}'::json),
        queue_name,
        coalesce(run_at, now()),
        coalesce(max_attempts, 25),
        job_key,
        coalesce(priority, 0),
        (
          select jsonb_object_agg(flag, true)
          from unnest(flags) as item(flag)
        )
      )
      on conflict (key)
      -- Bump the revision so that there's something to return
      do update set revision = jobs.revision + 1
      returning *
      into v_job;
    return v_job;
  elsif job_key is not null then
    raise exception 'Invalid job_key_mode value, expected ''replace'', ''preserve_run_at'' or ''unsafe_dedupe''.' using errcode = 'GWBKM';
  end if;
  -- insert the new job. Assume no conflicts due to the update above
  insert into "graphile_worker".jobs(
    task_identifier,
    payload,
    queue_name,
    run_at,
    max_attempts,
    key,
    priority,
    flags
  )
    values(
      identifier,
      coalesce(payload, '{}'::json),
      queue_name,
      coalesce(run_at, now()),
      coalesce(max_attempts, 25),
      job_key,
      coalesce(priority, 0),
      (
        select jsonb_object_agg(flag, true)
        from unnest(flags) as item(flag)
      )
    )
    returning *
    into v_job;
  return v_job;
end;
$$;


ALTER FUNCTION graphile_worker.add_job(identifier text, payload json, queue_name text, run_at timestamp with time zone, max_attempts integer, job_key text, priority integer, flags text[], job_key_mode text) OWNER TO posthog;

--
-- Name: complete_job(text, bigint); Type: FUNCTION; Schema: graphile_worker; Owner: posthog
--

CREATE FUNCTION graphile_worker.complete_job(worker_id text, job_id bigint) RETURNS graphile_worker.jobs
    LANGUAGE plpgsql
    AS $$
declare
  v_row "graphile_worker".jobs;
begin
  delete from "graphile_worker".jobs
    where id = job_id
    returning * into v_row;

  if v_row.queue_name is not null then
    update "graphile_worker".job_queues
      set locked_by = null, locked_at = null
      where queue_name = v_row.queue_name and locked_by = worker_id;
  end if;

  return v_row;
end;
$$;


ALTER FUNCTION graphile_worker.complete_job(worker_id text, job_id bigint) OWNER TO posthog;

--
-- Name: complete_jobs(bigint[]); Type: FUNCTION; Schema: graphile_worker; Owner: posthog
--

CREATE FUNCTION graphile_worker.complete_jobs(job_ids bigint[]) RETURNS SETOF graphile_worker.jobs
    LANGUAGE sql
    AS $$
  delete from "graphile_worker".jobs
    where id = any(job_ids)
    and (
      locked_by is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;


ALTER FUNCTION graphile_worker.complete_jobs(job_ids bigint[]) OWNER TO posthog;

--
-- Name: fail_job(text, bigint, text); Type: FUNCTION; Schema: graphile_worker; Owner: posthog
--

CREATE FUNCTION graphile_worker.fail_job(worker_id text, job_id bigint, error_message text) RETURNS graphile_worker.jobs
    LANGUAGE plpgsql STRICT
    AS $$
declare
  v_row "graphile_worker".jobs;
begin
  update "graphile_worker".jobs
    set
      last_error = error_message,
      run_at = greatest(now(), run_at) + (exp(least(attempts, 10))::text || ' seconds')::interval,
      locked_by = null,
      locked_at = null
    where id = job_id and locked_by = worker_id
    returning * into v_row;

  if v_row.queue_name is not null then
    update "graphile_worker".job_queues
      set locked_by = null, locked_at = null
      where queue_name = v_row.queue_name and locked_by = worker_id;
  end if;

  return v_row;
end;
$$;


ALTER FUNCTION graphile_worker.fail_job(worker_id text, job_id bigint, error_message text) OWNER TO posthog;

--
-- Name: get_job(text, text[], interval, text[]); Type: FUNCTION; Schema: graphile_worker; Owner: posthog
--

CREATE FUNCTION graphile_worker.get_job(worker_id text, task_identifiers text[] DEFAULT NULL::text[], job_expiry interval DEFAULT '04:00:00'::interval, forbidden_flags text[] DEFAULT NULL::text[]) RETURNS graphile_worker.jobs
    LANGUAGE plpgsql
    AS $$
declare
  v_job_id bigint;
  v_queue_name text;
  v_row "graphile_worker".jobs;
  v_now timestamptz = now();
begin
  if worker_id is null or length(worker_id) < 10 then
    raise exception 'invalid worker id';
  end if;

  select jobs.queue_name, jobs.id into v_queue_name, v_job_id
    from "graphile_worker".jobs
    where (jobs.locked_at is null or jobs.locked_at < (v_now - job_expiry))
    and (
      jobs.queue_name is null
    or
      exists (
        select 1
        from "graphile_worker".job_queues
        where job_queues.queue_name = jobs.queue_name
        and (job_queues.locked_at is null or job_queues.locked_at < (v_now - job_expiry))
        for update
        skip locked
      )
    )
    and run_at <= v_now
    and attempts < max_attempts
    and (task_identifiers is null or task_identifier = any(task_identifiers))
    and (forbidden_flags is null or (flags ?| forbidden_flags) is not true)
    order by priority asc, run_at asc, id asc
    limit 1
    for update
    skip locked;

  if v_job_id is null then
    return null;
  end if;

  if v_queue_name is not null then
    update "graphile_worker".job_queues
      set
        locked_by = worker_id,
        locked_at = v_now
      where job_queues.queue_name = v_queue_name;
  end if;

  update "graphile_worker".jobs
    set
      attempts = attempts + 1,
      locked_by = worker_id,
      locked_at = v_now
    where id = v_job_id
    returning * into v_row;

  return v_row;
end;
$$;


ALTER FUNCTION graphile_worker.get_job(worker_id text, task_identifiers text[], job_expiry interval, forbidden_flags text[]) OWNER TO posthog;

--
-- Name: jobs__decrease_job_queue_count(); Type: FUNCTION; Schema: graphile_worker; Owner: posthog
--

CREATE FUNCTION graphile_worker.jobs__decrease_job_queue_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_new_job_count int;
begin
  update "graphile_worker".job_queues
    set job_count = job_queues.job_count - 1
    where queue_name = old.queue_name
    returning job_count into v_new_job_count;

  if v_new_job_count <= 0 then
    delete from "graphile_worker".job_queues where queue_name = old.queue_name and job_count <= 0;
  end if;

  return old;
end;
$$;


ALTER FUNCTION graphile_worker.jobs__decrease_job_queue_count() OWNER TO posthog;

--
-- Name: jobs__increase_job_queue_count(); Type: FUNCTION; Schema: graphile_worker; Owner: posthog
--

CREATE FUNCTION graphile_worker.jobs__increase_job_queue_count() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  insert into "graphile_worker".job_queues(queue_name, job_count)
    values(new.queue_name, 1)
    on conflict (queue_name)
    do update
    set job_count = job_queues.job_count + 1;

  return new;
end;
$$;


ALTER FUNCTION graphile_worker.jobs__increase_job_queue_count() OWNER TO posthog;

--
-- Name: permanently_fail_jobs(bigint[], text); Type: FUNCTION; Schema: graphile_worker; Owner: posthog
--

CREATE FUNCTION graphile_worker.permanently_fail_jobs(job_ids bigint[], error_message text DEFAULT NULL::text) RETURNS SETOF graphile_worker.jobs
    LANGUAGE sql
    AS $$
  update "graphile_worker".jobs
    set
      last_error = coalesce(error_message, 'Manually marked as failed'),
      attempts = max_attempts
    where id = any(job_ids)
    and (
      locked_by is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;


ALTER FUNCTION graphile_worker.permanently_fail_jobs(job_ids bigint[], error_message text) OWNER TO posthog;

--
-- Name: remove_job(text); Type: FUNCTION; Schema: graphile_worker; Owner: posthog
--

CREATE FUNCTION graphile_worker.remove_job(job_key text) RETURNS graphile_worker.jobs
    LANGUAGE plpgsql STRICT
    AS $$
declare
  v_job "graphile_worker".jobs;
begin
  -- Delete job if not locked
  delete from "graphile_worker".jobs
    where key = job_key
    and locked_at is null
  returning * into v_job;
  if not (v_job is null) then
    return v_job;
  end if;
  -- Otherwise prevent job from retrying, and clear the key
  update "graphile_worker".jobs
    set attempts = max_attempts, key = null
    where key = job_key
  returning * into v_job;
  return v_job;
end;
$$;


ALTER FUNCTION graphile_worker.remove_job(job_key text) OWNER TO posthog;

--
-- Name: reschedule_jobs(bigint[], timestamp with time zone, integer, integer, integer); Type: FUNCTION; Schema: graphile_worker; Owner: posthog
--

CREATE FUNCTION graphile_worker.reschedule_jobs(job_ids bigint[], run_at timestamp with time zone DEFAULT NULL::timestamp with time zone, priority integer DEFAULT NULL::integer, attempts integer DEFAULT NULL::integer, max_attempts integer DEFAULT NULL::integer) RETURNS SETOF graphile_worker.jobs
    LANGUAGE sql
    AS $$
  update "graphile_worker".jobs
    set
      run_at = coalesce(reschedule_jobs.run_at, jobs.run_at),
      priority = coalesce(reschedule_jobs.priority, jobs.priority),
      attempts = coalesce(reschedule_jobs.attempts, jobs.attempts),
      max_attempts = coalesce(reschedule_jobs.max_attempts, jobs.max_attempts)
    where id = any(job_ids)
    and (
      locked_by is null
    or
      locked_at < NOW() - interval '4 hours'
    )
    returning *;
$$;


ALTER FUNCTION graphile_worker.reschedule_jobs(job_ids bigint[], run_at timestamp with time zone, priority integer, attempts integer, max_attempts integer) OWNER TO posthog;

--
-- Name: tg__update_timestamp(); Type: FUNCTION; Schema: graphile_worker; Owner: posthog
--

CREATE FUNCTION graphile_worker.tg__update_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = greatest(now(), old.updated_at + interval '1 millisecond');
  return new;
end;
$$;


ALTER FUNCTION graphile_worker.tg__update_timestamp() OWNER TO posthog;

--
-- Name: tg_jobs__notify_new_jobs(); Type: FUNCTION; Schema: graphile_worker; Owner: posthog
--

CREATE FUNCTION graphile_worker.tg_jobs__notify_new_jobs() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  perform pg_notify('jobs:insert', '');
  return new;
end;
$$;


ALTER FUNCTION graphile_worker.tg_jobs__notify_new_jobs() OWNER TO posthog;

--
-- Name: job_queues; Type: TABLE; Schema: graphile_worker; Owner: posthog
--

CREATE TABLE graphile_worker.job_queues (
    queue_name text NOT NULL,
    job_count integer NOT NULL,
    locked_at timestamp with time zone,
    locked_by text
);


ALTER TABLE graphile_worker.job_queues OWNER TO posthog;

--
-- Name: jobs_id_seq; Type: SEQUENCE; Schema: graphile_worker; Owner: posthog
--

CREATE SEQUENCE graphile_worker.jobs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE graphile_worker.jobs_id_seq OWNER TO posthog;

--
-- Name: jobs_id_seq; Type: SEQUENCE OWNED BY; Schema: graphile_worker; Owner: posthog
--

ALTER SEQUENCE graphile_worker.jobs_id_seq OWNED BY graphile_worker.jobs.id;


--
-- Name: known_crontabs; Type: TABLE; Schema: graphile_worker; Owner: posthog
--

CREATE TABLE graphile_worker.known_crontabs (
    identifier text NOT NULL,
    known_since timestamp with time zone NOT NULL,
    last_execution timestamp with time zone
);


ALTER TABLE graphile_worker.known_crontabs OWNER TO posthog;

--
-- Name: migrations; Type: TABLE; Schema: graphile_worker; Owner: posthog
--

CREATE TABLE graphile_worker.migrations (
    id integer NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL
);


ALTER TABLE graphile_worker.migrations OWNER TO posthog;

--
-- Name: auth_group; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.auth_group (
    id integer NOT NULL,
    name character varying(150) NOT NULL
);


ALTER TABLE public.auth_group OWNER TO posthog;

--
-- Name: auth_group_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.auth_group_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.auth_group_id_seq OWNER TO posthog;

--
-- Name: auth_group_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.auth_group_id_seq OWNED BY public.auth_group.id;


--
-- Name: auth_group_permissions; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.auth_group_permissions (
    id integer NOT NULL,
    group_id integer NOT NULL,
    permission_id integer NOT NULL
);


ALTER TABLE public.auth_group_permissions OWNER TO posthog;

--
-- Name: auth_group_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.auth_group_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.auth_group_permissions_id_seq OWNER TO posthog;

--
-- Name: auth_group_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.auth_group_permissions_id_seq OWNED BY public.auth_group_permissions.id;


--
-- Name: auth_permission; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.auth_permission (
    id integer NOT NULL,
    name character varying(255) NOT NULL,
    content_type_id integer NOT NULL,
    codename character varying(100) NOT NULL
);


ALTER TABLE public.auth_permission OWNER TO posthog;

--
-- Name: auth_permission_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.auth_permission_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.auth_permission_id_seq OWNER TO posthog;

--
-- Name: auth_permission_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.auth_permission_id_seq OWNED BY public.auth_permission.id;


--
-- Name: axes_accessattempt; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.axes_accessattempt (
    id integer NOT NULL,
    user_agent character varying(255) NOT NULL,
    ip_address inet,
    username character varying(255),
    http_accept character varying(1025) NOT NULL,
    path_info character varying(255) NOT NULL,
    attempt_time timestamp with time zone NOT NULL,
    get_data text NOT NULL,
    post_data text NOT NULL,
    failures_since_start integer NOT NULL,
    CONSTRAINT axes_accessattempt_failures_since_start_check CHECK ((failures_since_start >= 0))
);


ALTER TABLE public.axes_accessattempt OWNER TO posthog;

--
-- Name: axes_accessattempt_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.axes_accessattempt_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.axes_accessattempt_id_seq OWNER TO posthog;

--
-- Name: axes_accessattempt_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.axes_accessattempt_id_seq OWNED BY public.axes_accessattempt.id;


--
-- Name: axes_accesslog; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.axes_accesslog (
    id integer NOT NULL,
    user_agent character varying(255) NOT NULL,
    ip_address inet,
    username character varying(255),
    http_accept character varying(1025) NOT NULL,
    path_info character varying(255) NOT NULL,
    attempt_time timestamp with time zone NOT NULL,
    logout_time timestamp with time zone
);


ALTER TABLE public.axes_accesslog OWNER TO posthog;

--
-- Name: axes_accesslog_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.axes_accesslog_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.axes_accesslog_id_seq OWNER TO posthog;

--
-- Name: axes_accesslog_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.axes_accesslog_id_seq OWNED BY public.axes_accesslog.id;


--
-- Name: django_admin_log; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.django_admin_log (
    id integer NOT NULL,
    action_time timestamp with time zone NOT NULL,
    object_id text,
    object_repr character varying(200) NOT NULL,
    action_flag smallint NOT NULL,
    change_message text NOT NULL,
    content_type_id integer,
    user_id integer NOT NULL,
    CONSTRAINT django_admin_log_action_flag_check CHECK ((action_flag >= 0))
);


ALTER TABLE public.django_admin_log OWNER TO posthog;

--
-- Name: django_admin_log_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.django_admin_log_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.django_admin_log_id_seq OWNER TO posthog;

--
-- Name: django_admin_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.django_admin_log_id_seq OWNED BY public.django_admin_log.id;


--
-- Name: django_content_type; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.django_content_type (
    id integer NOT NULL,
    app_label character varying(100) NOT NULL,
    model character varying(100) NOT NULL
);


ALTER TABLE public.django_content_type OWNER TO posthog;

--
-- Name: django_content_type_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.django_content_type_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.django_content_type_id_seq OWNER TO posthog;

--
-- Name: django_content_type_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.django_content_type_id_seq OWNED BY public.django_content_type.id;


--
-- Name: django_migrations; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.django_migrations (
    id integer NOT NULL,
    app character varying(255) NOT NULL,
    name character varying(255) NOT NULL,
    applied timestamp with time zone NOT NULL
);


ALTER TABLE public.django_migrations OWNER TO posthog;

--
-- Name: django_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.django_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.django_migrations_id_seq OWNER TO posthog;

--
-- Name: django_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.django_migrations_id_seq OWNED BY public.django_migrations.id;


--
-- Name: django_session; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.django_session (
    session_key character varying(40) NOT NULL,
    session_data text NOT NULL,
    expire_date timestamp with time zone NOT NULL
);


ALTER TABLE public.django_session OWNER TO posthog;

--
-- Name: ee_enterpriseeventdefinition; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.ee_enterpriseeventdefinition (
    eventdefinition_ptr_id uuid NOT NULL,
    description character varying(400) NOT NULL,
    tags character varying(32)[],
    updated_at timestamp with time zone NOT NULL,
    owner_id integer,
    updated_by_id integer
);


ALTER TABLE public.ee_enterpriseeventdefinition OWNER TO posthog;

--
-- Name: ee_enterprisepropertydefinition; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.ee_enterprisepropertydefinition (
    propertydefinition_ptr_id uuid NOT NULL,
    description character varying(400) NOT NULL,
    tags character varying(32)[],
    updated_at timestamp with time zone NOT NULL,
    updated_by_id integer
);


ALTER TABLE public.ee_enterprisepropertydefinition OWNER TO posthog;

--
-- Name: ee_hook; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.ee_hook (
    created timestamp with time zone NOT NULL,
    updated timestamp with time zone NOT NULL,
    event character varying(64) NOT NULL,
    target character varying(255) NOT NULL,
    id character varying(50) NOT NULL,
    resource_id integer,
    team_id integer NOT NULL,
    user_id integer NOT NULL
);


ALTER TABLE public.ee_hook OWNER TO posthog;

--
-- Name: ee_license; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.ee_license (
    id integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    plan character varying(200) NOT NULL,
    valid_until timestamp with time zone NOT NULL,
    key character varying(200) NOT NULL,
    max_users integer
);


ALTER TABLE public.ee_license OWNER TO posthog;

--
-- Name: ee_license_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.ee_license_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.ee_license_id_seq OWNER TO posthog;

--
-- Name: ee_license_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.ee_license_id_seq OWNED BY public.ee_license.id;


--
-- Name: posthog_action; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_action (
    id integer NOT NULL,
    name character varying(400),
    created_at timestamp with time zone NOT NULL,
    created_by_id integer,
    team_id integer NOT NULL,
    deleted boolean NOT NULL,
    post_to_slack boolean NOT NULL,
    is_calculating boolean NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    last_calculated_at timestamp with time zone NOT NULL,
    slack_message_format character varying(200) NOT NULL
);


ALTER TABLE public.posthog_action OWNER TO posthog;

--
-- Name: posthog_action_events; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_action_events (
    id integer NOT NULL,
    action_id integer NOT NULL,
    event_id integer NOT NULL
);


ALTER TABLE public.posthog_action_events OWNER TO posthog;

--
-- Name: posthog_action_events_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_action_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_action_events_id_seq OWNER TO posthog;

--
-- Name: posthog_action_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_action_events_id_seq OWNED BY public.posthog_action_events.id;


--
-- Name: posthog_action_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_action_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_action_id_seq OWNER TO posthog;

--
-- Name: posthog_action_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_action_id_seq OWNED BY public.posthog_action.id;


--
-- Name: posthog_actionstep; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_actionstep (
    id integer NOT NULL,
    tag_name character varying(400),
    text character varying(400),
    href character varying(65535),
    selector character varying(65535),
    url character varying(65535),
    name character varying(400),
    action_id integer NOT NULL,
    event character varying(400),
    url_matching character varying(400),
    properties jsonb
);


ALTER TABLE public.posthog_actionstep OWNER TO posthog;

--
-- Name: posthog_actionstep_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_actionstep_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_actionstep_id_seq OWNER TO posthog;

--
-- Name: posthog_actionstep_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_actionstep_id_seq OWNED BY public.posthog_actionstep.id;


--
-- Name: posthog_annotation; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_annotation (
    id integer NOT NULL,
    content character varying(400),
    created_at timestamp with time zone,
    updated_at timestamp with time zone NOT NULL,
    creation_type character varying(3) NOT NULL,
    apply_all boolean,
    deleted boolean NOT NULL,
    date_marker timestamp with time zone,
    created_by_id integer,
    dashboard_item_id integer,
    team_id integer NOT NULL,
    scope character varying(24) NOT NULL,
    organization_id uuid
);


ALTER TABLE public.posthog_annotation OWNER TO posthog;

--
-- Name: posthog_annotation_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_annotation_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_annotation_id_seq OWNER TO posthog;

--
-- Name: posthog_annotation_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_annotation_id_seq OWNED BY public.posthog_annotation.id;


--
-- Name: posthog_cohort; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_cohort (
    id integer NOT NULL,
    name character varying(400),
    deleted boolean NOT NULL,
    groups jsonb NOT NULL,
    team_id integer NOT NULL,
    created_at timestamp with time zone,
    created_by_id integer,
    is_calculating boolean NOT NULL,
    last_calculation timestamp with time zone,
    errors_calculating integer NOT NULL,
    is_static boolean NOT NULL
);


ALTER TABLE public.posthog_cohort OWNER TO posthog;

--
-- Name: posthog_cohort_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_cohort_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_cohort_id_seq OWNER TO posthog;

--
-- Name: posthog_cohort_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_cohort_id_seq OWNED BY public.posthog_cohort.id;


--
-- Name: posthog_cohortpeople; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_cohortpeople (
    id bigint NOT NULL,
    cohort_id integer NOT NULL,
    person_id integer NOT NULL
);


ALTER TABLE public.posthog_cohortpeople OWNER TO posthog;

--
-- Name: posthog_cohortpeople_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_cohortpeople_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_cohortpeople_id_seq OWNER TO posthog;

--
-- Name: posthog_cohortpeople_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_cohortpeople_id_seq OWNED BY public.posthog_cohortpeople.id;


--
-- Name: posthog_dashboard; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_dashboard (
    id integer NOT NULL,
    name character varying(400),
    pinned boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    deleted boolean NOT NULL,
    created_by_id integer,
    team_id integer NOT NULL,
    is_shared boolean NOT NULL,
    share_token character varying(400),
    last_accessed_at timestamp with time zone,
    filters jsonb NOT NULL,
    creation_mode character varying(16) NOT NULL,
    description text NOT NULL,
    tags character varying(32)[] NOT NULL
);


ALTER TABLE public.posthog_dashboard OWNER TO posthog;

--
-- Name: posthog_dashboard_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_dashboard_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_dashboard_id_seq OWNER TO posthog;

--
-- Name: posthog_dashboard_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_dashboard_id_seq OWNED BY public.posthog_dashboard.id;


--
-- Name: posthog_dashboarditem; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_dashboarditem (
    id integer NOT NULL,
    name character varying(400),
    filters jsonb NOT NULL,
    "order" integer,
    type character varying(400),
    deleted boolean NOT NULL,
    team_id integer NOT NULL,
    dashboard_id integer,
    layouts jsonb NOT NULL,
    color character varying(400),
    last_refresh timestamp with time zone,
    refreshing boolean NOT NULL,
    funnel integer,
    created_at timestamp with time zone,
    created_by_id integer,
    saved boolean NOT NULL,
    description character varying(400),
    is_sample boolean NOT NULL,
    filters_hash character varying(400),
    short_id character varying(12) NOT NULL,
    favorited boolean NOT NULL,
    tags character varying(32)[] NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    dive_dashboard_id integer
);


ALTER TABLE public.posthog_dashboarditem OWNER TO posthog;

--
-- Name: posthog_dashboarditem_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_dashboarditem_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_dashboarditem_id_seq OWNER TO posthog;

--
-- Name: posthog_dashboarditem_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_dashboarditem_id_seq OWNED BY public.posthog_dashboarditem.id;


--
-- Name: posthog_element; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_element (
    id integer NOT NULL,
    text character varying(10000),
    tag_name character varying(1000),
    href character varying(10000),
    attr_id character varying(10000),
    nth_child integer,
    nth_of_type integer,
    attributes jsonb NOT NULL,
    "order" integer,
    event_id integer,
    attr_class character varying(200)[],
    group_id integer
);


ALTER TABLE public.posthog_element OWNER TO posthog;

--
-- Name: posthog_element_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_element_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_element_id_seq OWNER TO posthog;

--
-- Name: posthog_element_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_element_id_seq OWNED BY public.posthog_element.id;


--
-- Name: posthog_elementgroup; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_elementgroup (
    id integer NOT NULL,
    hash character varying(400),
    team_id integer NOT NULL
);


ALTER TABLE public.posthog_elementgroup OWNER TO posthog;

--
-- Name: posthog_elementgroup_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_elementgroup_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_elementgroup_id_seq OWNER TO posthog;

--
-- Name: posthog_elementgroup_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_elementgroup_id_seq OWNED BY public.posthog_elementgroup.id;


--
-- Name: posthog_event; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_event (
    id integer NOT NULL,
    event character varying(200),
    properties jsonb NOT NULL,
    elements jsonb,
    "timestamp" timestamp with time zone NOT NULL,
    team_id integer NOT NULL,
    distinct_id character varying(200) NOT NULL,
    elements_hash character varying(200),
    created_at timestamp with time zone,
    site_url character varying(200)
);


ALTER TABLE public.posthog_event OWNER TO posthog;

--
-- Name: posthog_event_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_event_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_event_id_seq OWNER TO posthog;

--
-- Name: posthog_event_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_event_id_seq OWNED BY public.posthog_event.id;


--
-- Name: posthog_eventdefinition; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_eventdefinition (
    id uuid NOT NULL,
    name character varying(400) NOT NULL,
    volume_30_day integer,
    query_usage_30_day integer,
    team_id integer NOT NULL
);


ALTER TABLE public.posthog_eventdefinition OWNER TO posthog;

--
-- Name: posthog_featureflag; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_featureflag (
    id integer NOT NULL,
    name text NOT NULL,
    key character varying(400) NOT NULL,
    filters jsonb NOT NULL,
    rollout_percentage integer,
    created_at timestamp with time zone NOT NULL,
    deleted boolean NOT NULL,
    active boolean NOT NULL,
    created_by_id integer NOT NULL,
    team_id integer NOT NULL
);


ALTER TABLE public.posthog_featureflag OWNER TO posthog;

--
-- Name: posthog_featureflag_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_featureflag_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_featureflag_id_seq OWNER TO posthog;

--
-- Name: posthog_featureflag_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_featureflag_id_seq OWNED BY public.posthog_featureflag.id;


--
-- Name: posthog_messagingrecord; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_messagingrecord (
    id uuid NOT NULL,
    email_hash character varying(1024) NOT NULL,
    campaign_key character varying(128) NOT NULL,
    sent_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL
);


ALTER TABLE public.posthog_messagingrecord OWNER TO posthog;

--
-- Name: posthog_organization; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_organization (
    id uuid NOT NULL,
    name character varying(64) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    personalization jsonb NOT NULL,
    setup_section_2_completed boolean NOT NULL,
    plugins_access_level smallint NOT NULL,
    for_internal_metrics boolean NOT NULL,
    available_features character varying(64)[] NOT NULL,
    domain_whitelist character varying(256)[] NOT NULL,
    is_member_join_email_enabled boolean NOT NULL,
    CONSTRAINT posthog_organization_plugins_access_level_check CHECK ((plugins_access_level >= 0))
);


ALTER TABLE public.posthog_organization OWNER TO posthog;

--
-- Name: posthog_organizationinvite; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_organizationinvite (
    id uuid NOT NULL,
    target_email character varying(254),
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    created_by_id integer,
    organization_id uuid NOT NULL,
    emailing_attempt_made boolean NOT NULL,
    first_name character varying(30) NOT NULL
);


ALTER TABLE public.posthog_organizationinvite OWNER TO posthog;

--
-- Name: posthog_organizationmembership; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_organizationmembership (
    id uuid NOT NULL,
    level smallint NOT NULL,
    joined_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    organization_id uuid NOT NULL,
    user_id integer NOT NULL,
    CONSTRAINT posthog_organizationmembership_level_check CHECK ((level >= 0))
);


ALTER TABLE public.posthog_organizationmembership OWNER TO posthog;

--
-- Name: posthog_person; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_person (
    id integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    properties jsonb NOT NULL,
    team_id integer NOT NULL,
    is_user_id integer,
    is_identified boolean NOT NULL,
    uuid uuid NOT NULL
);


ALTER TABLE public.posthog_person OWNER TO posthog;

--
-- Name: posthog_person_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_person_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_person_id_seq OWNER TO posthog;

--
-- Name: posthog_person_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_person_id_seq OWNED BY public.posthog_person.id;


--
-- Name: posthog_personalapikey; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_personalapikey (
    id character varying(50) NOT NULL,
    label character varying(40) NOT NULL,
    value character varying(50) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    last_used_at timestamp with time zone,
    team_id integer,
    user_id integer NOT NULL
);


ALTER TABLE public.posthog_personalapikey OWNER TO posthog;

--
-- Name: posthog_persondistinctid; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_persondistinctid (
    id integer NOT NULL,
    distinct_id character varying(400) NOT NULL,
    person_id integer NOT NULL,
    team_id integer NOT NULL
);


ALTER TABLE public.posthog_persondistinctid OWNER TO posthog;

--
-- Name: posthog_persondistinctid_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_persondistinctid_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_persondistinctid_id_seq OWNER TO posthog;

--
-- Name: posthog_persondistinctid_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_persondistinctid_id_seq OWNED BY public.posthog_persondistinctid.id;


--
-- Name: posthog_plugin; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_plugin (
    id integer NOT NULL,
    name character varying(200),
    description text,
    url character varying(800),
    config_schema jsonb NOT NULL,
    tag character varying(200),
    archive bytea,
    from_json boolean NOT NULL,
    from_web boolean NOT NULL,
    error jsonb,
    plugin_type character varying(200),
    source text,
    organization_id uuid NOT NULL,
    latest_tag character varying(800),
    latest_tag_checked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    is_global boolean NOT NULL,
    is_preinstalled boolean NOT NULL,
    capabilities jsonb NOT NULL,
    metrics jsonb,
    public_jobs jsonb
);


ALTER TABLE public.posthog_plugin OWNER TO posthog;

--
-- Name: posthog_plugin_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_plugin_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_plugin_id_seq OWNER TO posthog;

--
-- Name: posthog_plugin_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_plugin_id_seq OWNED BY public.posthog_plugin.id;


--
-- Name: posthog_pluginattachment; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_pluginattachment (
    id integer NOT NULL,
    key character varying(200) NOT NULL,
    content_type character varying(200) NOT NULL,
    file_name character varying(200) NOT NULL,
    file_size integer NOT NULL,
    contents bytea NOT NULL,
    plugin_config_id integer,
    team_id integer
);


ALTER TABLE public.posthog_pluginattachment OWNER TO posthog;

--
-- Name: posthog_pluginattachment_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_pluginattachment_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_pluginattachment_id_seq OWNER TO posthog;

--
-- Name: posthog_pluginattachment_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_pluginattachment_id_seq OWNED BY public.posthog_pluginattachment.id;


--
-- Name: posthog_pluginconfig; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_pluginconfig (
    id integer NOT NULL,
    enabled boolean NOT NULL,
    "order" integer NOT NULL,
    config jsonb NOT NULL,
    error jsonb,
    plugin_id integer NOT NULL,
    team_id integer,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


ALTER TABLE public.posthog_pluginconfig OWNER TO posthog;

--
-- Name: posthog_pluginconfig_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_pluginconfig_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_pluginconfig_id_seq OWNER TO posthog;

--
-- Name: posthog_pluginconfig_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_pluginconfig_id_seq OWNED BY public.posthog_pluginconfig.id;


--
-- Name: posthog_pluginlogentry; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_pluginlogentry (
    id uuid NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    source character varying(20) NOT NULL,
    type character varying(20) NOT NULL,
    message text NOT NULL,
    instance_id uuid NOT NULL,
    plugin_id integer NOT NULL,
    plugin_config_id integer NOT NULL,
    team_id integer NOT NULL
);


ALTER TABLE public.posthog_pluginlogentry OWNER TO posthog;

--
-- Name: posthog_pluginstorage; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_pluginstorage (
    id integer NOT NULL,
    key character varying(200) NOT NULL,
    value text,
    plugin_config_id integer NOT NULL
);


ALTER TABLE public.posthog_pluginstorage OWNER TO posthog;

--
-- Name: posthog_pluginstorage_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_pluginstorage_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_pluginstorage_id_seq OWNER TO posthog;

--
-- Name: posthog_pluginstorage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_pluginstorage_id_seq OWNED BY public.posthog_pluginstorage.id;


--
-- Name: posthog_propertydefinition; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_propertydefinition (
    id uuid NOT NULL,
    name character varying(400) NOT NULL,
    is_numerical boolean NOT NULL,
    volume_30_day integer,
    query_usage_30_day integer,
    team_id integer NOT NULL
);


ALTER TABLE public.posthog_propertydefinition OWNER TO posthog;

--
-- Name: posthog_sessionrecordingevent; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_sessionrecordingevent (
    id integer NOT NULL,
    created_at timestamp with time zone,
    "timestamp" timestamp with time zone NOT NULL,
    session_id character varying(200) NOT NULL,
    distinct_id character varying(200) NOT NULL,
    snapshot_data jsonb NOT NULL,
    team_id integer NOT NULL
);


ALTER TABLE public.posthog_sessionrecordingevent OWNER TO posthog;

--
-- Name: posthog_sessionrecordingevent_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_sessionrecordingevent_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_sessionrecordingevent_id_seq OWNER TO posthog;

--
-- Name: posthog_sessionrecordingevent_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_sessionrecordingevent_id_seq OWNED BY public.posthog_sessionrecordingevent.id;


--
-- Name: posthog_sessionrecordingviewed; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_sessionrecordingviewed (
    id integer NOT NULL,
    created_at timestamp with time zone,
    session_id character varying(200) NOT NULL,
    team_id integer NOT NULL,
    user_id integer NOT NULL
);


ALTER TABLE public.posthog_sessionrecordingviewed OWNER TO posthog;

--
-- Name: posthog_sessionrecordingviewed_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_sessionrecordingviewed_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_sessionrecordingviewed_id_seq OWNER TO posthog;

--
-- Name: posthog_sessionrecordingviewed_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_sessionrecordingviewed_id_seq OWNED BY public.posthog_sessionrecordingviewed.id;


--
-- Name: posthog_sessionsfilter; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_sessionsfilter (
    id integer NOT NULL,
    name character varying(400) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    filters jsonb NOT NULL,
    created_by_id integer,
    team_id integer NOT NULL
);


ALTER TABLE public.posthog_sessionsfilter OWNER TO posthog;

--
-- Name: posthog_sessionsfilter_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_sessionsfilter_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_sessionsfilter_id_seq OWNER TO posthog;

--
-- Name: posthog_sessionsfilter_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_sessionsfilter_id_seq OWNED BY public.posthog_sessionsfilter.id;


--
-- Name: posthog_team; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_team (
    id integer NOT NULL,
    api_token character varying(200) NOT NULL,
    name character varying(200) NOT NULL,
    opt_out_capture boolean NOT NULL,
    signup_token character varying(200),
    app_urls character varying(200)[] NOT NULL,
    slack_incoming_webhook character varying(500),
    event_names jsonb NOT NULL,
    event_properties jsonb NOT NULL,
    anonymize_ips boolean NOT NULL,
    completed_snippet_onboarding boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    event_properties_numerical jsonb NOT NULL,
    ingested_event boolean NOT NULL,
    uuid uuid NOT NULL,
    organization_id uuid NOT NULL,
    session_recording_opt_in boolean NOT NULL,
    plugins_opt_in boolean NOT NULL,
    event_names_with_usage jsonb NOT NULL,
    event_properties_with_usage jsonb NOT NULL,
    session_recording_retention_period_days integer,
    is_demo boolean NOT NULL,
    test_account_filters jsonb NOT NULL,
    timezone character varying(240) NOT NULL,
    data_attributes jsonb NOT NULL
);


ALTER TABLE public.posthog_team OWNER TO posthog;

--
-- Name: posthog_team_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_team_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_team_id_seq OWNER TO posthog;

--
-- Name: posthog_team_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_team_id_seq OWNED BY public.posthog_team.id;


--
-- Name: posthog_team_users; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_team_users (
    id integer NOT NULL,
    team_id integer NOT NULL,
    user_id integer NOT NULL
);


ALTER TABLE public.posthog_team_users OWNER TO posthog;

--
-- Name: posthog_team_users_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_team_users_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_team_users_id_seq OWNER TO posthog;

--
-- Name: posthog_team_users_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_team_users_id_seq OWNED BY public.posthog_team_users.id;


--
-- Name: posthog_user; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_user (
    id integer NOT NULL,
    password character varying(128) NOT NULL,
    last_login timestamp with time zone,
    first_name character varying(150) NOT NULL,
    last_name character varying(150) NOT NULL,
    email character varying(254) NOT NULL,
    is_staff boolean NOT NULL,
    is_active boolean NOT NULL,
    date_joined timestamp with time zone NOT NULL,
    temporary_token character varying(200),
    distinct_id character varying(200),
    email_opt_in boolean,
    anonymize_data boolean,
    toolbar_mode character varying(200),
    current_team_id integer,
    current_organization_id uuid,
    uuid uuid NOT NULL,
    events_column_config jsonb NOT NULL
);


ALTER TABLE public.posthog_user OWNER TO posthog;

--
-- Name: posthog_user_groups; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_user_groups (
    id integer NOT NULL,
    user_id integer NOT NULL,
    group_id integer NOT NULL
);


ALTER TABLE public.posthog_user_groups OWNER TO posthog;

--
-- Name: posthog_user_groups_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_user_groups_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_user_groups_id_seq OWNER TO posthog;

--
-- Name: posthog_user_groups_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_user_groups_id_seq OWNED BY public.posthog_user_groups.id;


--
-- Name: posthog_user_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_user_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_user_id_seq OWNER TO posthog;

--
-- Name: posthog_user_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_user_id_seq OWNED BY public.posthog_user.id;


--
-- Name: posthog_user_user_permissions; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.posthog_user_user_permissions (
    id integer NOT NULL,
    user_id integer NOT NULL,
    permission_id integer NOT NULL
);


ALTER TABLE public.posthog_user_user_permissions OWNER TO posthog;

--
-- Name: posthog_user_user_permissions_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.posthog_user_user_permissions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.posthog_user_user_permissions_id_seq OWNER TO posthog;

--
-- Name: posthog_user_user_permissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.posthog_user_user_permissions_id_seq OWNED BY public.posthog_user_user_permissions.id;


--
-- Name: rest_hooks_hook; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.rest_hooks_hook (
    id integer NOT NULL,
    created timestamp with time zone NOT NULL,
    updated timestamp with time zone NOT NULL,
    event character varying(64) NOT NULL,
    target character varying(255) NOT NULL,
    user_id integer NOT NULL
);


ALTER TABLE public.rest_hooks_hook OWNER TO posthog;

--
-- Name: rest_hooks_hook_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.rest_hooks_hook_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.rest_hooks_hook_id_seq OWNER TO posthog;

--
-- Name: rest_hooks_hook_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.rest_hooks_hook_id_seq OWNED BY public.rest_hooks_hook.id;


--
-- Name: social_auth_association; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.social_auth_association (
    id integer NOT NULL,
    server_url character varying(255) NOT NULL,
    handle character varying(255) NOT NULL,
    secret character varying(255) NOT NULL,
    issued integer NOT NULL,
    lifetime integer NOT NULL,
    assoc_type character varying(64) NOT NULL
);


ALTER TABLE public.social_auth_association OWNER TO posthog;

--
-- Name: social_auth_association_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.social_auth_association_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.social_auth_association_id_seq OWNER TO posthog;

--
-- Name: social_auth_association_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.social_auth_association_id_seq OWNED BY public.social_auth_association.id;


--
-- Name: social_auth_code; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.social_auth_code (
    id integer NOT NULL,
    email character varying(254) NOT NULL,
    code character varying(32) NOT NULL,
    verified boolean NOT NULL,
    "timestamp" timestamp with time zone NOT NULL
);


ALTER TABLE public.social_auth_code OWNER TO posthog;

--
-- Name: social_auth_code_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.social_auth_code_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.social_auth_code_id_seq OWNER TO posthog;

--
-- Name: social_auth_code_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.social_auth_code_id_seq OWNED BY public.social_auth_code.id;


--
-- Name: social_auth_nonce; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.social_auth_nonce (
    id integer NOT NULL,
    server_url character varying(255) NOT NULL,
    "timestamp" integer NOT NULL,
    salt character varying(65) NOT NULL
);


ALTER TABLE public.social_auth_nonce OWNER TO posthog;

--
-- Name: social_auth_nonce_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.social_auth_nonce_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.social_auth_nonce_id_seq OWNER TO posthog;

--
-- Name: social_auth_nonce_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.social_auth_nonce_id_seq OWNED BY public.social_auth_nonce.id;


--
-- Name: social_auth_partial; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.social_auth_partial (
    id integer NOT NULL,
    token character varying(32) NOT NULL,
    next_step smallint NOT NULL,
    backend character varying(32) NOT NULL,
    data jsonb NOT NULL,
    "timestamp" timestamp with time zone NOT NULL,
    CONSTRAINT social_auth_partial_next_step_check CHECK ((next_step >= 0))
);


ALTER TABLE public.social_auth_partial OWNER TO posthog;

--
-- Name: social_auth_partial_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.social_auth_partial_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.social_auth_partial_id_seq OWNER TO posthog;

--
-- Name: social_auth_partial_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.social_auth_partial_id_seq OWNED BY public.social_auth_partial.id;


--
-- Name: social_auth_usersocialauth; Type: TABLE; Schema: public; Owner: posthog
--

CREATE TABLE public.social_auth_usersocialauth (
    id integer NOT NULL,
    provider character varying(32) NOT NULL,
    uid character varying(255) NOT NULL,
    extra_data jsonb NOT NULL,
    user_id integer NOT NULL,
    created timestamp with time zone NOT NULL,
    modified timestamp with time zone NOT NULL
);


ALTER TABLE public.social_auth_usersocialauth OWNER TO posthog;

--
-- Name: social_auth_usersocialauth_id_seq; Type: SEQUENCE; Schema: public; Owner: posthog
--

CREATE SEQUENCE public.social_auth_usersocialauth_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER TABLE public.social_auth_usersocialauth_id_seq OWNER TO posthog;

--
-- Name: social_auth_usersocialauth_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: posthog
--

ALTER SEQUENCE public.social_auth_usersocialauth_id_seq OWNED BY public.social_auth_usersocialauth.id;


--
-- Name: jobs id; Type: DEFAULT; Schema: graphile_worker; Owner: posthog
--

ALTER TABLE ONLY graphile_worker.jobs ALTER COLUMN id SET DEFAULT nextval('graphile_worker.jobs_id_seq'::regclass);


--
-- Name: auth_group id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.auth_group ALTER COLUMN id SET DEFAULT nextval('public.auth_group_id_seq'::regclass);


--
-- Name: auth_group_permissions id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.auth_group_permissions ALTER COLUMN id SET DEFAULT nextval('public.auth_group_permissions_id_seq'::regclass);


--
-- Name: auth_permission id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.auth_permission ALTER COLUMN id SET DEFAULT nextval('public.auth_permission_id_seq'::regclass);


--
-- Name: axes_accessattempt id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.axes_accessattempt ALTER COLUMN id SET DEFAULT nextval('public.axes_accessattempt_id_seq'::regclass);


--
-- Name: axes_accesslog id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.axes_accesslog ALTER COLUMN id SET DEFAULT nextval('public.axes_accesslog_id_seq'::regclass);


--
-- Name: django_admin_log id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.django_admin_log ALTER COLUMN id SET DEFAULT nextval('public.django_admin_log_id_seq'::regclass);


--
-- Name: django_content_type id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.django_content_type ALTER COLUMN id SET DEFAULT nextval('public.django_content_type_id_seq'::regclass);


--
-- Name: django_migrations id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.django_migrations ALTER COLUMN id SET DEFAULT nextval('public.django_migrations_id_seq'::regclass);


--
-- Name: ee_license id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.ee_license ALTER COLUMN id SET DEFAULT nextval('public.ee_license_id_seq'::regclass);


--
-- Name: posthog_action id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_action ALTER COLUMN id SET DEFAULT nextval('public.posthog_action_id_seq'::regclass);


--
-- Name: posthog_action_events id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_action_events ALTER COLUMN id SET DEFAULT nextval('public.posthog_action_events_id_seq'::regclass);


--
-- Name: posthog_actionstep id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_actionstep ALTER COLUMN id SET DEFAULT nextval('public.posthog_actionstep_id_seq'::regclass);


--
-- Name: posthog_annotation id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_annotation ALTER COLUMN id SET DEFAULT nextval('public.posthog_annotation_id_seq'::regclass);


--
-- Name: posthog_cohort id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_cohort ALTER COLUMN id SET DEFAULT nextval('public.posthog_cohort_id_seq'::regclass);


--
-- Name: posthog_cohortpeople id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_cohortpeople ALTER COLUMN id SET DEFAULT nextval('public.posthog_cohortpeople_id_seq'::regclass);


--
-- Name: posthog_dashboard id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_dashboard ALTER COLUMN id SET DEFAULT nextval('public.posthog_dashboard_id_seq'::regclass);


--
-- Name: posthog_dashboarditem id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_dashboarditem ALTER COLUMN id SET DEFAULT nextval('public.posthog_dashboarditem_id_seq'::regclass);


--
-- Name: posthog_element id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_element ALTER COLUMN id SET DEFAULT nextval('public.posthog_element_id_seq'::regclass);


--
-- Name: posthog_elementgroup id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_elementgroup ALTER COLUMN id SET DEFAULT nextval('public.posthog_elementgroup_id_seq'::regclass);


--
-- Name: posthog_event id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_event ALTER COLUMN id SET DEFAULT nextval('public.posthog_event_id_seq'::regclass);


--
-- Name: posthog_featureflag id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_featureflag ALTER COLUMN id SET DEFAULT nextval('public.posthog_featureflag_id_seq'::regclass);


--
-- Name: posthog_person id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_person ALTER COLUMN id SET DEFAULT nextval('public.posthog_person_id_seq'::regclass);


--
-- Name: posthog_persondistinctid id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_persondistinctid ALTER COLUMN id SET DEFAULT nextval('public.posthog_persondistinctid_id_seq'::regclass);


--
-- Name: posthog_plugin id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_plugin ALTER COLUMN id SET DEFAULT nextval('public.posthog_plugin_id_seq'::regclass);


--
-- Name: posthog_pluginattachment id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginattachment ALTER COLUMN id SET DEFAULT nextval('public.posthog_pluginattachment_id_seq'::regclass);


--
-- Name: posthog_pluginconfig id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginconfig ALTER COLUMN id SET DEFAULT nextval('public.posthog_pluginconfig_id_seq'::regclass);


--
-- Name: posthog_pluginstorage id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginstorage ALTER COLUMN id SET DEFAULT nextval('public.posthog_pluginstorage_id_seq'::regclass);


--
-- Name: posthog_sessionrecordingevent id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_sessionrecordingevent ALTER COLUMN id SET DEFAULT nextval('public.posthog_sessionrecordingevent_id_seq'::regclass);


--
-- Name: posthog_sessionrecordingviewed id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_sessionrecordingviewed ALTER COLUMN id SET DEFAULT nextval('public.posthog_sessionrecordingviewed_id_seq'::regclass);


--
-- Name: posthog_sessionsfilter id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_sessionsfilter ALTER COLUMN id SET DEFAULT nextval('public.posthog_sessionsfilter_id_seq'::regclass);


--
-- Name: posthog_team id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_team ALTER COLUMN id SET DEFAULT nextval('public.posthog_team_id_seq'::regclass);


--
-- Name: posthog_team_users id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_team_users ALTER COLUMN id SET DEFAULT nextval('public.posthog_team_users_id_seq'::regclass);


--
-- Name: posthog_user id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user ALTER COLUMN id SET DEFAULT nextval('public.posthog_user_id_seq'::regclass);


--
-- Name: posthog_user_groups id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user_groups ALTER COLUMN id SET DEFAULT nextval('public.posthog_user_groups_id_seq'::regclass);


--
-- Name: posthog_user_user_permissions id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user_user_permissions ALTER COLUMN id SET DEFAULT nextval('public.posthog_user_user_permissions_id_seq'::regclass);


--
-- Name: rest_hooks_hook id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.rest_hooks_hook ALTER COLUMN id SET DEFAULT nextval('public.rest_hooks_hook_id_seq'::regclass);


--
-- Name: social_auth_association id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_association ALTER COLUMN id SET DEFAULT nextval('public.social_auth_association_id_seq'::regclass);


--
-- Name: social_auth_code id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_code ALTER COLUMN id SET DEFAULT nextval('public.social_auth_code_id_seq'::regclass);


--
-- Name: social_auth_nonce id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_nonce ALTER COLUMN id SET DEFAULT nextval('public.social_auth_nonce_id_seq'::regclass);


--
-- Name: social_auth_partial id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_partial ALTER COLUMN id SET DEFAULT nextval('public.social_auth_partial_id_seq'::regclass);


--
-- Name: social_auth_usersocialauth id; Type: DEFAULT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_usersocialauth ALTER COLUMN id SET DEFAULT nextval('public.social_auth_usersocialauth_id_seq'::regclass);


--
-- Name: job_queues job_queues_pkey; Type: CONSTRAINT; Schema: graphile_worker; Owner: posthog
--

ALTER TABLE ONLY graphile_worker.job_queues
    ADD CONSTRAINT job_queues_pkey PRIMARY KEY (queue_name);


--
-- Name: jobs jobs_key_key; Type: CONSTRAINT; Schema: graphile_worker; Owner: posthog
--

ALTER TABLE ONLY graphile_worker.jobs
    ADD CONSTRAINT jobs_key_key UNIQUE (key);


--
-- Name: jobs jobs_pkey; Type: CONSTRAINT; Schema: graphile_worker; Owner: posthog
--

ALTER TABLE ONLY graphile_worker.jobs
    ADD CONSTRAINT jobs_pkey PRIMARY KEY (id);


--
-- Name: known_crontabs known_crontabs_pkey; Type: CONSTRAINT; Schema: graphile_worker; Owner: posthog
--

ALTER TABLE ONLY graphile_worker.known_crontabs
    ADD CONSTRAINT known_crontabs_pkey PRIMARY KEY (identifier);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: graphile_worker; Owner: posthog
--

ALTER TABLE ONLY graphile_worker.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (id);


--
-- Name: auth_group auth_group_name_key; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.auth_group
    ADD CONSTRAINT auth_group_name_key UNIQUE (name);


--
-- Name: auth_group_permissions auth_group_permissions_group_id_permission_id_0cd325b0_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.auth_group_permissions
    ADD CONSTRAINT auth_group_permissions_group_id_permission_id_0cd325b0_uniq UNIQUE (group_id, permission_id);


--
-- Name: auth_group_permissions auth_group_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.auth_group_permissions
    ADD CONSTRAINT auth_group_permissions_pkey PRIMARY KEY (id);


--
-- Name: auth_group auth_group_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.auth_group
    ADD CONSTRAINT auth_group_pkey PRIMARY KEY (id);


--
-- Name: auth_permission auth_permission_content_type_id_codename_01ab375a_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.auth_permission
    ADD CONSTRAINT auth_permission_content_type_id_codename_01ab375a_uniq UNIQUE (content_type_id, codename);


--
-- Name: auth_permission auth_permission_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.auth_permission
    ADD CONSTRAINT auth_permission_pkey PRIMARY KEY (id);


--
-- Name: axes_accessattempt axes_accessattempt_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.axes_accessattempt
    ADD CONSTRAINT axes_accessattempt_pkey PRIMARY KEY (id);


--
-- Name: axes_accesslog axes_accesslog_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.axes_accesslog
    ADD CONSTRAINT axes_accesslog_pkey PRIMARY KEY (id);


--
-- Name: django_admin_log django_admin_log_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.django_admin_log
    ADD CONSTRAINT django_admin_log_pkey PRIMARY KEY (id);


--
-- Name: django_content_type django_content_type_app_label_model_76bd3d3b_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.django_content_type
    ADD CONSTRAINT django_content_type_app_label_model_76bd3d3b_uniq UNIQUE (app_label, model);


--
-- Name: django_content_type django_content_type_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.django_content_type
    ADD CONSTRAINT django_content_type_pkey PRIMARY KEY (id);


--
-- Name: django_migrations django_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.django_migrations
    ADD CONSTRAINT django_migrations_pkey PRIMARY KEY (id);


--
-- Name: django_session django_session_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.django_session
    ADD CONSTRAINT django_session_pkey PRIMARY KEY (session_key);


--
-- Name: ee_enterpriseeventdefinition ee_enterpriseeventdefinition_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.ee_enterpriseeventdefinition
    ADD CONSTRAINT ee_enterpriseeventdefinition_pkey PRIMARY KEY (eventdefinition_ptr_id);


--
-- Name: ee_enterprisepropertydefinition ee_enterprisepropertydefinition_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.ee_enterprisepropertydefinition
    ADD CONSTRAINT ee_enterprisepropertydefinition_pkey PRIMARY KEY (propertydefinition_ptr_id);


--
-- Name: ee_hook ee_hook_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.ee_hook
    ADD CONSTRAINT ee_hook_pkey PRIMARY KEY (id);


--
-- Name: ee_license ee_license_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.ee_license
    ADD CONSTRAINT ee_license_pkey PRIMARY KEY (id);


--
-- Name: posthog_action_events posthog_action_events_action_id_event_id_18e163e2_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_action_events
    ADD CONSTRAINT posthog_action_events_action_id_event_id_18e163e2_uniq UNIQUE (action_id, event_id);


--
-- Name: posthog_action_events posthog_action_events_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_action_events
    ADD CONSTRAINT posthog_action_events_pkey PRIMARY KEY (id);


--
-- Name: posthog_action posthog_action_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_action
    ADD CONSTRAINT posthog_action_pkey PRIMARY KEY (id);


--
-- Name: posthog_actionstep posthog_actionstep_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_actionstep
    ADD CONSTRAINT posthog_actionstep_pkey PRIMARY KEY (id);


--
-- Name: posthog_annotation posthog_annotation_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_annotation
    ADD CONSTRAINT posthog_annotation_pkey PRIMARY KEY (id);


--
-- Name: posthog_cohort posthog_cohort_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_cohort
    ADD CONSTRAINT posthog_cohort_pkey PRIMARY KEY (id);


--
-- Name: posthog_cohortpeople posthog_cohortpeople_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_cohortpeople
    ADD CONSTRAINT posthog_cohortpeople_pkey PRIMARY KEY (id);


--
-- Name: posthog_dashboard posthog_dashboard_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_dashboard
    ADD CONSTRAINT posthog_dashboard_pkey PRIMARY KEY (id);


--
-- Name: posthog_dashboarditem posthog_dashboarditem_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_dashboarditem
    ADD CONSTRAINT posthog_dashboarditem_pkey PRIMARY KEY (id);


--
-- Name: posthog_dashboarditem posthog_dashboarditem_team_id_short_id_1b8c199d_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_dashboarditem
    ADD CONSTRAINT posthog_dashboarditem_team_id_short_id_1b8c199d_uniq UNIQUE (team_id, short_id);


--
-- Name: posthog_element posthog_element_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_element
    ADD CONSTRAINT posthog_element_pkey PRIMARY KEY (id);


--
-- Name: posthog_elementgroup posthog_elementgroup_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_elementgroup
    ADD CONSTRAINT posthog_elementgroup_pkey PRIMARY KEY (id);


--
-- Name: posthog_event posthog_event_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_event
    ADD CONSTRAINT posthog_event_pkey PRIMARY KEY (id);


--
-- Name: posthog_eventdefinition posthog_eventdefinition_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_eventdefinition
    ADD CONSTRAINT posthog_eventdefinition_pkey PRIMARY KEY (id);


--
-- Name: posthog_eventdefinition posthog_eventdefinition_team_id_name_80fa0b87_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_eventdefinition
    ADD CONSTRAINT posthog_eventdefinition_team_id_name_80fa0b87_uniq UNIQUE (team_id, name);


--
-- Name: posthog_featureflag posthog_featureflag_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_featureflag
    ADD CONSTRAINT posthog_featureflag_pkey PRIMARY KEY (id);


--
-- Name: posthog_messagingrecord posthog_messagingrecord_email_hash_campaign_key_6639a13f_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_messagingrecord
    ADD CONSTRAINT posthog_messagingrecord_email_hash_campaign_key_6639a13f_uniq UNIQUE (email_hash, campaign_key);


--
-- Name: posthog_messagingrecord posthog_messagingrecord_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_messagingrecord
    ADD CONSTRAINT posthog_messagingrecord_pkey PRIMARY KEY (id);


--
-- Name: posthog_organization posthog_organization_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_organization
    ADD CONSTRAINT posthog_organization_pkey PRIMARY KEY (id);


--
-- Name: posthog_organizationinvite posthog_organizationinvite_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_organizationinvite
    ADD CONSTRAINT posthog_organizationinvite_pkey PRIMARY KEY (id);


--
-- Name: posthog_organizationmembership posthog_organizationmembership_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_organizationmembership
    ADD CONSTRAINT posthog_organizationmembership_pkey PRIMARY KEY (id);


--
-- Name: posthog_person posthog_person_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_person
    ADD CONSTRAINT posthog_person_pkey PRIMARY KEY (id);


--
-- Name: posthog_personalapikey posthog_personalapikey_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_personalapikey
    ADD CONSTRAINT posthog_personalapikey_pkey PRIMARY KEY (id);


--
-- Name: posthog_personalapikey posthog_personalapikey_value_key; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_personalapikey
    ADD CONSTRAINT posthog_personalapikey_value_key UNIQUE (value);


--
-- Name: posthog_persondistinctid posthog_persondistinctid_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_persondistinctid
    ADD CONSTRAINT posthog_persondistinctid_pkey PRIMARY KEY (id);


--
-- Name: posthog_plugin posthog_plugin_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_plugin
    ADD CONSTRAINT posthog_plugin_pkey PRIMARY KEY (id);


--
-- Name: posthog_pluginattachment posthog_pluginattachment_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginattachment
    ADD CONSTRAINT posthog_pluginattachment_pkey PRIMARY KEY (id);


--
-- Name: posthog_pluginconfig posthog_pluginconfig_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginconfig
    ADD CONSTRAINT posthog_pluginconfig_pkey PRIMARY KEY (id);


--
-- Name: posthog_pluginlogentry posthog_pluginlogentry_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginlogentry
    ADD CONSTRAINT posthog_pluginlogentry_pkey PRIMARY KEY (id);


--
-- Name: posthog_pluginstorage posthog_pluginstorage_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginstorage
    ADD CONSTRAINT posthog_pluginstorage_pkey PRIMARY KEY (id);


--
-- Name: posthog_propertydefinition posthog_propertydefinition_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_propertydefinition
    ADD CONSTRAINT posthog_propertydefinition_pkey PRIMARY KEY (id);


--
-- Name: posthog_propertydefinition posthog_propertydefinition_team_id_name_e21599fc_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_propertydefinition
    ADD CONSTRAINT posthog_propertydefinition_team_id_name_e21599fc_uniq UNIQUE (team_id, name);


--
-- Name: posthog_sessionrecordingviewed posthog_sessionrecording_team_id_user_id_session__ac83dfde_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_sessionrecordingviewed
    ADD CONSTRAINT posthog_sessionrecording_team_id_user_id_session__ac83dfde_uniq UNIQUE (team_id, user_id, session_id);


--
-- Name: posthog_sessionrecordingevent posthog_sessionrecordingevent_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_sessionrecordingevent
    ADD CONSTRAINT posthog_sessionrecordingevent_pkey PRIMARY KEY (id);


--
-- Name: posthog_sessionrecordingviewed posthog_sessionrecordingviewed_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_sessionrecordingviewed
    ADD CONSTRAINT posthog_sessionrecordingviewed_pkey PRIMARY KEY (id);


--
-- Name: posthog_sessionsfilter posthog_sessionsfilter_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_sessionsfilter
    ADD CONSTRAINT posthog_sessionsfilter_pkey PRIMARY KEY (id);


--
-- Name: posthog_team posthog_team_api_token_a9a1df8a_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_team
    ADD CONSTRAINT posthog_team_api_token_a9a1df8a_uniq UNIQUE (api_token);


--
-- Name: posthog_team posthog_team_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_team
    ADD CONSTRAINT posthog_team_pkey PRIMARY KEY (id);


--
-- Name: posthog_team_users posthog_team_users_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_team_users
    ADD CONSTRAINT posthog_team_users_pkey PRIMARY KEY (id);


--
-- Name: posthog_team_users posthog_team_users_team_id_user_id_c8bb8e32_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_team_users
    ADD CONSTRAINT posthog_team_users_team_id_user_id_c8bb8e32_uniq UNIQUE (team_id, user_id);


--
-- Name: posthog_team posthog_team_uuid_daa094af_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_team
    ADD CONSTRAINT posthog_team_uuid_daa094af_uniq UNIQUE (uuid);


--
-- Name: posthog_pluginstorage posthog_unique_plugin_storage_key; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginstorage
    ADD CONSTRAINT posthog_unique_plugin_storage_key UNIQUE (plugin_config_id, key);


--
-- Name: posthog_user posthog_user_distinct_id_dcd52541_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user
    ADD CONSTRAINT posthog_user_distinct_id_dcd52541_uniq UNIQUE (distinct_id);


--
-- Name: posthog_user posthog_user_email_af269794_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user
    ADD CONSTRAINT posthog_user_email_af269794_uniq UNIQUE (email);


--
-- Name: posthog_user_groups posthog_user_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user_groups
    ADD CONSTRAINT posthog_user_groups_pkey PRIMARY KEY (id);


--
-- Name: posthog_user_groups posthog_user_groups_user_id_group_id_e8f9e2be_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user_groups
    ADD CONSTRAINT posthog_user_groups_user_id_group_id_e8f9e2be_uniq UNIQUE (user_id, group_id);


--
-- Name: posthog_user posthog_user_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user
    ADD CONSTRAINT posthog_user_pkey PRIMARY KEY (id);


--
-- Name: posthog_user posthog_user_temporary_token_9d7b57f3_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user
    ADD CONSTRAINT posthog_user_temporary_token_9d7b57f3_uniq UNIQUE (temporary_token);


--
-- Name: posthog_user_user_permissions posthog_user_user_permis_user_id_permission_id_1dc68b66_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user_user_permissions
    ADD CONSTRAINT posthog_user_user_permis_user_id_permission_id_1dc68b66_uniq UNIQUE (user_id, permission_id);


--
-- Name: posthog_user_user_permissions posthog_user_user_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user_user_permissions
    ADD CONSTRAINT posthog_user_user_permissions_pkey PRIMARY KEY (id);


--
-- Name: posthog_user posthog_user_uuid_cbc0c307_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user
    ADD CONSTRAINT posthog_user_uuid_cbc0c307_uniq UNIQUE (uuid);


--
-- Name: rest_hooks_hook rest_hooks_hook_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.rest_hooks_hook
    ADD CONSTRAINT rest_hooks_hook_pkey PRIMARY KEY (id);


--
-- Name: social_auth_association social_auth_association_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_association
    ADD CONSTRAINT social_auth_association_pkey PRIMARY KEY (id);


--
-- Name: social_auth_association social_auth_association_server_url_handle_078befa2_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_association
    ADD CONSTRAINT social_auth_association_server_url_handle_078befa2_uniq UNIQUE (server_url, handle);


--
-- Name: social_auth_code social_auth_code_email_code_801b2d02_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_code
    ADD CONSTRAINT social_auth_code_email_code_801b2d02_uniq UNIQUE (email, code);


--
-- Name: social_auth_code social_auth_code_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_code
    ADD CONSTRAINT social_auth_code_pkey PRIMARY KEY (id);


--
-- Name: social_auth_nonce social_auth_nonce_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_nonce
    ADD CONSTRAINT social_auth_nonce_pkey PRIMARY KEY (id);


--
-- Name: social_auth_nonce social_auth_nonce_server_url_timestamp_salt_f6284463_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_nonce
    ADD CONSTRAINT social_auth_nonce_server_url_timestamp_salt_f6284463_uniq UNIQUE (server_url, "timestamp", salt);


--
-- Name: social_auth_partial social_auth_partial_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_partial
    ADD CONSTRAINT social_auth_partial_pkey PRIMARY KEY (id);


--
-- Name: social_auth_usersocialauth social_auth_usersocialauth_pkey; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_usersocialauth
    ADD CONSTRAINT social_auth_usersocialauth_pkey PRIMARY KEY (id);


--
-- Name: social_auth_usersocialauth social_auth_usersocialauth_provider_uid_e6b5e668_uniq; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_usersocialauth
    ADD CONSTRAINT social_auth_usersocialauth_provider_uid_e6b5e668_uniq UNIQUE (provider, uid);


--
-- Name: posthog_persondistinctid unique distinct_id for team; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_persondistinctid
    ADD CONSTRAINT "unique distinct_id for team" UNIQUE (team_id, distinct_id);


--
-- Name: posthog_elementgroup unique hash for each team; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_elementgroup
    ADD CONSTRAINT "unique hash for each team" UNIQUE (team_id, hash);


--
-- Name: posthog_featureflag unique key for team; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_featureflag
    ADD CONSTRAINT "unique key for team" UNIQUE (team_id, key);


--
-- Name: posthog_organizationmembership unique_organization_membership; Type: CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_organizationmembership
    ADD CONSTRAINT unique_organization_membership UNIQUE (organization_id, user_id);


--
-- Name: jobs_priority_run_at_id_locked_at_without_failures_idx; Type: INDEX; Schema: graphile_worker; Owner: posthog
--

CREATE INDEX jobs_priority_run_at_id_locked_at_without_failures_idx ON graphile_worker.jobs USING btree (priority, run_at, id, locked_at) WHERE (attempts < max_attempts);


--
-- Name: auth_group_name_a6ea08ec_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX auth_group_name_a6ea08ec_like ON public.auth_group USING btree (name varchar_pattern_ops);


--
-- Name: auth_group_permissions_group_id_b120cbf9; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX auth_group_permissions_group_id_b120cbf9 ON public.auth_group_permissions USING btree (group_id);


--
-- Name: auth_group_permissions_permission_id_84c5c92e; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX auth_group_permissions_permission_id_84c5c92e ON public.auth_group_permissions USING btree (permission_id);


--
-- Name: auth_permission_content_type_id_2f476e4b; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX auth_permission_content_type_id_2f476e4b ON public.auth_permission USING btree (content_type_id);


--
-- Name: axes_accessattempt_ip_address_10922d9c; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX axes_accessattempt_ip_address_10922d9c ON public.axes_accessattempt USING btree (ip_address);


--
-- Name: axes_accessattempt_user_agent_ad89678b; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX axes_accessattempt_user_agent_ad89678b ON public.axes_accessattempt USING btree (user_agent);


--
-- Name: axes_accessattempt_user_agent_ad89678b_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX axes_accessattempt_user_agent_ad89678b_like ON public.axes_accessattempt USING btree (user_agent varchar_pattern_ops);


--
-- Name: axes_accessattempt_username_3f2d4ca0; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX axes_accessattempt_username_3f2d4ca0 ON public.axes_accessattempt USING btree (username);


--
-- Name: axes_accessattempt_username_3f2d4ca0_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX axes_accessattempt_username_3f2d4ca0_like ON public.axes_accessattempt USING btree (username varchar_pattern_ops);


--
-- Name: axes_accesslog_ip_address_86b417e5; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX axes_accesslog_ip_address_86b417e5 ON public.axes_accesslog USING btree (ip_address);


--
-- Name: axes_accesslog_user_agent_0e659004; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX axes_accesslog_user_agent_0e659004 ON public.axes_accesslog USING btree (user_agent);


--
-- Name: axes_accesslog_user_agent_0e659004_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX axes_accesslog_user_agent_0e659004_like ON public.axes_accesslog USING btree (user_agent varchar_pattern_ops);


--
-- Name: axes_accesslog_username_df93064b; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX axes_accesslog_username_df93064b ON public.axes_accesslog USING btree (username);


--
-- Name: axes_accesslog_username_df93064b_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX axes_accesslog_username_df93064b_like ON public.axes_accesslog USING btree (username varchar_pattern_ops);


--
-- Name: django_admin_log_content_type_id_c4bce8eb; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX django_admin_log_content_type_id_c4bce8eb ON public.django_admin_log USING btree (content_type_id);


--
-- Name: django_admin_log_user_id_c564eba6; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX django_admin_log_user_id_c564eba6 ON public.django_admin_log USING btree (user_id);


--
-- Name: django_session_expire_date_a5c62663; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX django_session_expire_date_a5c62663 ON public.django_session USING btree (expire_date);


--
-- Name: django_session_session_key_c0390e0f_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX django_session_session_key_c0390e0f_like ON public.django_session USING btree (session_key varchar_pattern_ops);


--
-- Name: ee_enterpriseeventdefinition_owner_id_67c5ef56; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX ee_enterpriseeventdefinition_owner_id_67c5ef56 ON public.ee_enterpriseeventdefinition USING btree (owner_id);


--
-- Name: ee_enterpriseeventdefinition_updated_by_id_7aede29e; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX ee_enterpriseeventdefinition_updated_by_id_7aede29e ON public.ee_enterpriseeventdefinition USING btree (updated_by_id);


--
-- Name: ee_enterprisepropertydefinition_updated_by_id_96e0be9d; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX ee_enterprisepropertydefinition_updated_by_id_96e0be9d ON public.ee_enterprisepropertydefinition USING btree (updated_by_id);


--
-- Name: ee_hook_event_12ccd200; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX ee_hook_event_12ccd200 ON public.ee_hook USING btree (event);


--
-- Name: ee_hook_event_12ccd200_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX ee_hook_event_12ccd200_like ON public.ee_hook USING btree (event varchar_pattern_ops);


--
-- Name: ee_hook_id_d4e48550_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX ee_hook_id_d4e48550_like ON public.ee_hook USING btree (id varchar_pattern_ops);


--
-- Name: ee_hook_team_id_638d0223; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX ee_hook_team_id_638d0223 ON public.ee_hook USING btree (team_id);


--
-- Name: ee_hook_user_id_442b7c5d; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX ee_hook_user_id_442b7c5d ON public.ee_hook USING btree (user_id);


--
-- Name: idx_distinct_id; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX idx_distinct_id ON public.posthog_event USING btree (distinct_id);


--
-- Name: index_event_definition_name; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX index_event_definition_name ON public.posthog_eventdefinition USING gin (name public.gin_trgm_ops);


--
-- Name: index_property_definition_name; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX index_property_definition_name ON public.posthog_propertydefinition USING gin (name public.gin_trgm_ops);


--
-- Name: only_one_owner_per_organization; Type: INDEX; Schema: public; Owner: posthog
--

CREATE UNIQUE INDEX only_one_owner_per_organization ON public.posthog_organizationmembership USING btree (organization_id) WHERE (level = 15);


--
-- Name: posthog_act_team_id_8c04de_idx; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_act_team_id_8c04de_idx ON public.posthog_action USING btree (team_id, updated_at DESC);


--
-- Name: posthog_action_created_by_id_4e7145d9; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_action_created_by_id_4e7145d9 ON public.posthog_action USING btree (created_by_id);


--
-- Name: posthog_action_events_action_id_f6f1f077; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_action_events_action_id_f6f1f077 ON public.posthog_action_events USING btree (action_id);


--
-- Name: posthog_action_events_event_id_7077ea70; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_action_events_event_id_7077ea70 ON public.posthog_action_events USING btree (event_id);


--
-- Name: posthog_action_team_id_3a21e3a6; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_action_team_id_3a21e3a6 ON public.posthog_action USING btree (team_id);


--
-- Name: posthog_actionstep_action_id_b50d75e6; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_actionstep_action_id_b50d75e6 ON public.posthog_actionstep USING btree (action_id);


--
-- Name: posthog_annotation_created_by_id_1b9c9223; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_annotation_created_by_id_1b9c9223 ON public.posthog_annotation USING btree (created_by_id);


--
-- Name: posthog_annotation_dashboard_item_id_8bfb9aa9; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_annotation_dashboard_item_id_8bfb9aa9 ON public.posthog_annotation USING btree (dashboard_item_id);


--
-- Name: posthog_annotation_organization_id_f5c9d877; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_annotation_organization_id_f5c9d877 ON public.posthog_annotation USING btree (organization_id);


--
-- Name: posthog_annotation_team_id_95adb263; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_annotation_team_id_95adb263 ON public.posthog_annotation USING btree (team_id);


--
-- Name: posthog_coh_cohort__89c25f_idx; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_coh_cohort__89c25f_idx ON public.posthog_cohortpeople USING btree (cohort_id, person_id);


--
-- Name: posthog_cohort_created_by_id_e003077a; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_cohort_created_by_id_e003077a ON public.posthog_cohort USING btree (created_by_id);


--
-- Name: posthog_cohort_team_id_8a849f3d; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_cohort_team_id_8a849f3d ON public.posthog_cohort USING btree (team_id);


--
-- Name: posthog_cohortpeople_cohort_id_1f371733; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_cohortpeople_cohort_id_1f371733 ON public.posthog_cohortpeople USING btree (cohort_id);


--
-- Name: posthog_cohortpeople_person_id_33da7d3f; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_cohortpeople_person_id_33da7d3f ON public.posthog_cohortpeople USING btree (person_id);


--
-- Name: posthog_dashboard_created_by_id_a528d2ca; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_dashboard_created_by_id_a528d2ca ON public.posthog_dashboard USING btree (created_by_id);


--
-- Name: posthog_dashboard_team_id_5c28ee1a; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_dashboard_team_id_5c28ee1a ON public.posthog_dashboard USING btree (team_id);


--
-- Name: posthog_dashboarditem_created_by_id_a3c81ce2; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_dashboarditem_created_by_id_a3c81ce2 ON public.posthog_dashboarditem USING btree (created_by_id);


--
-- Name: posthog_dashboarditem_dashboard_id_59e2811f; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_dashboarditem_dashboard_id_59e2811f ON public.posthog_dashboarditem USING btree (dashboard_id);


--
-- Name: posthog_dashboarditem_dive_dashboard_id_9ba0b080; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_dashboarditem_dive_dashboard_id_9ba0b080 ON public.posthog_dashboarditem USING btree (dive_dashboard_id);


--
-- Name: posthog_dashboarditem_team_id_a0e4bed0; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_dashboarditem_team_id_a0e4bed0 ON public.posthog_dashboarditem USING btree (team_id);


--
-- Name: posthog_element_event_id_bb6549a0; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_element_event_id_bb6549a0 ON public.posthog_element USING btree (event_id);


--
-- Name: posthog_element_group_id_09134876; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_element_group_id_09134876 ON public.posthog_element USING btree (group_id);


--
-- Name: posthog_elementgroup_team_id_3ced0286; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_elementgroup_team_id_3ced0286 ON public.posthog_elementgroup USING btree (team_id);


--
-- Name: posthog_eve_created_6a34ca_idx; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_eve_created_6a34ca_idx ON public.posthog_event USING btree (created_at);


--
-- Name: posthog_eve_element_48becd_idx; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_eve_element_48becd_idx ON public.posthog_event USING btree (elements_hash);


--
-- Name: posthog_eve_timesta_1f6a8c_idx; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_eve_timesta_1f6a8c_idx ON public.posthog_event USING btree ("timestamp", team_id, event);


--
-- Name: posthog_event_team_id_a8b4c6dc; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_event_team_id_a8b4c6dc ON public.posthog_event USING btree (team_id);


--
-- Name: posthog_eventdefinition_team_id_818ed0f2; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_eventdefinition_team_id_818ed0f2 ON public.posthog_eventdefinition USING btree (team_id);


--
-- Name: posthog_featureflag_created_by_id_4571fe1a; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_featureflag_created_by_id_4571fe1a ON public.posthog_featureflag USING btree (created_by_id);


--
-- Name: posthog_featureflag_team_id_51e383b9; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_featureflag_team_id_51e383b9 ON public.posthog_featureflag USING btree (team_id);


--
-- Name: posthog_organizationinvite_created_by_id_16cbc2ef; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_organizationinvite_created_by_id_16cbc2ef ON public.posthog_organizationinvite USING btree (created_by_id);


--
-- Name: posthog_organizationinvite_organization_id_15e2bab4; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_organizationinvite_organization_id_15e2bab4 ON public.posthog_organizationinvite USING btree (organization_id);


--
-- Name: posthog_organizationinvite_target_email_45fa23f6; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_organizationinvite_target_email_45fa23f6 ON public.posthog_organizationinvite USING btree (target_email);


--
-- Name: posthog_organizationinvite_target_email_45fa23f6_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_organizationinvite_target_email_45fa23f6_like ON public.posthog_organizationinvite USING btree (target_email varchar_pattern_ops);


--
-- Name: posthog_organizationmembership_organization_id_6f92360d; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_organizationmembership_organization_id_6f92360d ON public.posthog_organizationmembership USING btree (organization_id);


--
-- Name: posthog_organizationmembership_user_id_aab9f3c7; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_organizationmembership_user_id_aab9f3c7 ON public.posthog_organizationmembership USING btree (user_id);


--
-- Name: posthog_per_team_id_bec4e5_idx; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_per_team_id_bec4e5_idx ON public.posthog_person USING btree (team_id, id DESC);


--
-- Name: posthog_person_email; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_person_email ON public.posthog_person USING btree (((properties ->> 'email'::text)));


--
-- Name: posthog_person_is_user_id_cfc91ae7; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_person_is_user_id_cfc91ae7 ON public.posthog_person USING btree (is_user_id);


--
-- Name: posthog_person_team_id_325c1b73; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_person_team_id_325c1b73 ON public.posthog_person USING btree (team_id);


--
-- Name: posthog_person_uuid_82b4a3ed; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_person_uuid_82b4a3ed ON public.posthog_person USING btree (uuid);


--
-- Name: posthog_personalapikey_id_7b00e9cc_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_personalapikey_id_7b00e9cc_like ON public.posthog_personalapikey USING btree (id varchar_pattern_ops);


--
-- Name: posthog_personalapikey_team_id_813f490c; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_personalapikey_team_id_813f490c ON public.posthog_personalapikey USING btree (team_id);


--
-- Name: posthog_personalapikey_user_id_730a29e7; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_personalapikey_user_id_730a29e7 ON public.posthog_personalapikey USING btree (user_id);


--
-- Name: posthog_personalapikey_value_249c258b_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_personalapikey_value_249c258b_like ON public.posthog_personalapikey USING btree (value varchar_pattern_ops);


--
-- Name: posthog_persondistinctid_person_id_5d655bba; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_persondistinctid_person_id_5d655bba ON public.posthog_persondistinctid USING btree (person_id);


--
-- Name: posthog_persondistinctid_team_id_46330ec9; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_persondistinctid_team_id_46330ec9 ON public.posthog_persondistinctid USING btree (team_id);


--
-- Name: posthog_plu_plugin__736133_idx; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_plu_plugin__736133_idx ON public.posthog_pluginlogentry USING btree (plugin_config_id, "timestamp");


--
-- Name: posthog_plugin_organization_id_d040b9a9; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_plugin_organization_id_d040b9a9 ON public.posthog_plugin USING btree (organization_id);


--
-- Name: posthog_pluginattachment_plugin_config_id_cc94a1b9; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_pluginattachment_plugin_config_id_cc94a1b9 ON public.posthog_pluginattachment USING btree (plugin_config_id);


--
-- Name: posthog_pluginattachment_team_id_415eacc7; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_pluginattachment_team_id_415eacc7 ON public.posthog_pluginattachment USING btree (team_id);


--
-- Name: posthog_pluginconfig_plugin_id_d014ca1c; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_pluginconfig_plugin_id_d014ca1c ON public.posthog_pluginconfig USING btree (plugin_id);


--
-- Name: posthog_pluginconfig_team_id_71185766; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_pluginconfig_team_id_71185766 ON public.posthog_pluginconfig USING btree (team_id);


--
-- Name: posthog_pluginlogentry_message_3fb95ccc; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_pluginlogentry_message_3fb95ccc ON public.posthog_pluginlogentry USING btree (message);


--
-- Name: posthog_pluginlogentry_message_3fb95ccc_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_pluginlogentry_message_3fb95ccc_like ON public.posthog_pluginlogentry USING btree (message text_pattern_ops);


--
-- Name: posthog_pluginlogentry_plugin_config_id_2fe30023; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_pluginlogentry_plugin_config_id_2fe30023 ON public.posthog_pluginlogentry USING btree (plugin_config_id);


--
-- Name: posthog_pluginlogentry_plugin_id_42aaf74e; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_pluginlogentry_plugin_id_42aaf74e ON public.posthog_pluginlogentry USING btree (plugin_id);


--
-- Name: posthog_pluginlogentry_team_id_5cab32b2; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_pluginlogentry_team_id_5cab32b2 ON public.posthog_pluginlogentry USING btree (team_id);


--
-- Name: posthog_pluginstorage_plugin_config_id_6744363a; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_pluginstorage_plugin_config_id_6744363a ON public.posthog_pluginstorage USING btree (plugin_config_id);


--
-- Name: posthog_propertydefinition_team_id_b7abe702; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_propertydefinition_team_id_b7abe702 ON public.posthog_propertydefinition USING btree (team_id);


--
-- Name: posthog_ses_team_id_0409c4_idx; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_ses_team_id_0409c4_idx ON public.posthog_sessionrecordingevent USING btree (team_id, "timestamp");


--
-- Name: posthog_ses_team_id_265946_idx; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_ses_team_id_265946_idx ON public.posthog_sessionrecordingevent USING btree (team_id, session_id);


--
-- Name: posthog_ses_team_id_453d24_idx; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_ses_team_id_453d24_idx ON public.posthog_sessionsfilter USING btree (team_id, name);


--
-- Name: posthog_ses_team_id_46392f_idx; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_ses_team_id_46392f_idx ON public.posthog_sessionrecordingevent USING btree (team_id, distinct_id, "timestamp", session_id);


--
-- Name: posthog_ses_team_id_465af1_idx; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_ses_team_id_465af1_idx ON public.posthog_sessionrecordingviewed USING btree (team_id, user_id, session_id);


--
-- Name: posthog_sessionrecordingevent_team_id_974f0e0d; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_sessionrecordingevent_team_id_974f0e0d ON public.posthog_sessionrecordingevent USING btree (team_id);


--
-- Name: posthog_sessionrecordingviewed_team_id_5d0d59b9; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_sessionrecordingviewed_team_id_5d0d59b9 ON public.posthog_sessionrecordingviewed USING btree (team_id);


--
-- Name: posthog_sessionrecordingviewed_user_id_ef83047a; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_sessionrecordingviewed_user_id_ef83047a ON public.posthog_sessionrecordingviewed USING btree (user_id);


--
-- Name: posthog_sessionsfilter_created_by_id_06700ae9; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_sessionsfilter_created_by_id_06700ae9 ON public.posthog_sessionsfilter USING btree (created_by_id);


--
-- Name: posthog_sessionsfilter_team_id_59837f38; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_sessionsfilter_team_id_59837f38 ON public.posthog_sessionsfilter USING btree (team_id);


--
-- Name: posthog_team_api_token_a9a1df8a_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_team_api_token_a9a1df8a_like ON public.posthog_team USING btree (api_token varchar_pattern_ops);


--
-- Name: posthog_team_organization_id_41bbc1d0; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_team_organization_id_41bbc1d0 ON public.posthog_team USING btree (organization_id);


--
-- Name: posthog_team_users_team_id_2bd01272; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_team_users_team_id_2bd01272 ON public.posthog_team_users USING btree (team_id);


--
-- Name: posthog_team_users_user_id_c7bafb47; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_team_users_user_id_c7bafb47 ON public.posthog_team_users USING btree (user_id);


--
-- Name: posthog_user_current_organization_id_e8527570; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_user_current_organization_id_e8527570 ON public.posthog_user USING btree (current_organization_id);


--
-- Name: posthog_user_current_team_id_52760528; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_user_current_team_id_52760528 ON public.posthog_user USING btree (current_team_id);


--
-- Name: posthog_user_distinct_id_dcd52541_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_user_distinct_id_dcd52541_like ON public.posthog_user USING btree (distinct_id varchar_pattern_ops);


--
-- Name: posthog_user_email_af269794_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_user_email_af269794_like ON public.posthog_user USING btree (email varchar_pattern_ops);


--
-- Name: posthog_user_groups_group_id_75d77987; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_user_groups_group_id_75d77987 ON public.posthog_user_groups USING btree (group_id);


--
-- Name: posthog_user_groups_user_id_6b000a50; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_user_groups_user_id_6b000a50 ON public.posthog_user_groups USING btree (user_id);


--
-- Name: posthog_user_temporary_token_9d7b57f3_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_user_temporary_token_9d7b57f3_like ON public.posthog_user USING btree (temporary_token varchar_pattern_ops);


--
-- Name: posthog_user_user_permissions_permission_id_21270994; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_user_user_permissions_permission_id_21270994 ON public.posthog_user_user_permissions USING btree (permission_id);


--
-- Name: posthog_user_user_permissions_user_id_f94166b7; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX posthog_user_user_permissions_user_id_f94166b7 ON public.posthog_user_user_permissions USING btree (user_id);


--
-- Name: rest_hooks_hook_event_c9f86f88; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX rest_hooks_hook_event_c9f86f88 ON public.rest_hooks_hook USING btree (event);


--
-- Name: rest_hooks_hook_event_c9f86f88_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX rest_hooks_hook_event_c9f86f88_like ON public.rest_hooks_hook USING btree (event varchar_pattern_ops);


--
-- Name: rest_hooks_hook_user_id_94046fce; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX rest_hooks_hook_user_id_94046fce ON public.rest_hooks_hook USING btree (user_id);


--
-- Name: single_for_internal_metrics; Type: INDEX; Schema: public; Owner: posthog
--

CREATE UNIQUE INDEX single_for_internal_metrics ON public.posthog_organization USING btree (for_internal_metrics) WHERE for_internal_metrics;


--
-- Name: social_auth_code_code_a2393167; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX social_auth_code_code_a2393167 ON public.social_auth_code USING btree (code);


--
-- Name: social_auth_code_code_a2393167_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX social_auth_code_code_a2393167_like ON public.social_auth_code USING btree (code varchar_pattern_ops);


--
-- Name: social_auth_code_timestamp_176b341f; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX social_auth_code_timestamp_176b341f ON public.social_auth_code USING btree ("timestamp");


--
-- Name: social_auth_partial_timestamp_50f2119f; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX social_auth_partial_timestamp_50f2119f ON public.social_auth_partial USING btree ("timestamp");


--
-- Name: social_auth_partial_token_3017fea3; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX social_auth_partial_token_3017fea3 ON public.social_auth_partial USING btree (token);


--
-- Name: social_auth_partial_token_3017fea3_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX social_auth_partial_token_3017fea3_like ON public.social_auth_partial USING btree (token varchar_pattern_ops);


--
-- Name: social_auth_usersocialauth_uid_796e51dc; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX social_auth_usersocialauth_uid_796e51dc ON public.social_auth_usersocialauth USING btree (uid);


--
-- Name: social_auth_usersocialauth_uid_796e51dc_like; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX social_auth_usersocialauth_uid_796e51dc_like ON public.social_auth_usersocialauth USING btree (uid varchar_pattern_ops);


--
-- Name: social_auth_usersocialauth_user_id_17d28448; Type: INDEX; Schema: public; Owner: posthog
--

CREATE INDEX social_auth_usersocialauth_user_id_17d28448 ON public.social_auth_usersocialauth USING btree (user_id);


--
-- Name: jobs _100_timestamps; Type: TRIGGER; Schema: graphile_worker; Owner: posthog
--

CREATE TRIGGER _100_timestamps BEFORE UPDATE ON graphile_worker.jobs FOR EACH ROW EXECUTE FUNCTION graphile_worker.tg__update_timestamp();


--
-- Name: jobs _500_decrease_job_queue_count; Type: TRIGGER; Schema: graphile_worker; Owner: posthog
--

CREATE TRIGGER _500_decrease_job_queue_count AFTER DELETE ON graphile_worker.jobs FOR EACH ROW WHEN ((old.queue_name IS NOT NULL)) EXECUTE FUNCTION graphile_worker.jobs__decrease_job_queue_count();


--
-- Name: jobs _500_decrease_job_queue_count_update; Type: TRIGGER; Schema: graphile_worker; Owner: posthog
--

CREATE TRIGGER _500_decrease_job_queue_count_update AFTER UPDATE OF queue_name ON graphile_worker.jobs FOR EACH ROW WHEN (((new.queue_name IS DISTINCT FROM old.queue_name) AND (old.queue_name IS NOT NULL))) EXECUTE FUNCTION graphile_worker.jobs__decrease_job_queue_count();


--
-- Name: jobs _500_increase_job_queue_count; Type: TRIGGER; Schema: graphile_worker; Owner: posthog
--

CREATE TRIGGER _500_increase_job_queue_count AFTER INSERT ON graphile_worker.jobs FOR EACH ROW WHEN ((new.queue_name IS NOT NULL)) EXECUTE FUNCTION graphile_worker.jobs__increase_job_queue_count();


--
-- Name: jobs _500_increase_job_queue_count_update; Type: TRIGGER; Schema: graphile_worker; Owner: posthog
--

CREATE TRIGGER _500_increase_job_queue_count_update AFTER UPDATE OF queue_name ON graphile_worker.jobs FOR EACH ROW WHEN (((new.queue_name IS DISTINCT FROM old.queue_name) AND (new.queue_name IS NOT NULL))) EXECUTE FUNCTION graphile_worker.jobs__increase_job_queue_count();


--
-- Name: jobs _900_notify_worker; Type: TRIGGER; Schema: graphile_worker; Owner: posthog
--

CREATE TRIGGER _900_notify_worker AFTER INSERT ON graphile_worker.jobs FOR EACH STATEMENT EXECUTE FUNCTION graphile_worker.tg_jobs__notify_new_jobs();


--
-- Name: auth_group_permissions auth_group_permissio_permission_id_84c5c92e_fk_auth_perm; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.auth_group_permissions
    ADD CONSTRAINT auth_group_permissio_permission_id_84c5c92e_fk_auth_perm FOREIGN KEY (permission_id) REFERENCES public.auth_permission(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: auth_group_permissions auth_group_permissions_group_id_b120cbf9_fk_auth_group_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.auth_group_permissions
    ADD CONSTRAINT auth_group_permissions_group_id_b120cbf9_fk_auth_group_id FOREIGN KEY (group_id) REFERENCES public.auth_group(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: auth_permission auth_permission_content_type_id_2f476e4b_fk_django_co; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.auth_permission
    ADD CONSTRAINT auth_permission_content_type_id_2f476e4b_fk_django_co FOREIGN KEY (content_type_id) REFERENCES public.django_content_type(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: django_admin_log django_admin_log_content_type_id_c4bce8eb_fk_django_co; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.django_admin_log
    ADD CONSTRAINT django_admin_log_content_type_id_c4bce8eb_fk_django_co FOREIGN KEY (content_type_id) REFERENCES public.django_content_type(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: django_admin_log django_admin_log_user_id_c564eba6_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.django_admin_log
    ADD CONSTRAINT django_admin_log_user_id_c564eba6_fk_posthog_user_id FOREIGN KEY (user_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: ee_enterpriseeventdefinition ee_enterpriseeventde_eventdefinition_ptr__5b4562bd_fk_posthog_e; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.ee_enterpriseeventdefinition
    ADD CONSTRAINT ee_enterpriseeventde_eventdefinition_ptr__5b4562bd_fk_posthog_e FOREIGN KEY (eventdefinition_ptr_id) REFERENCES public.posthog_eventdefinition(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: ee_enterpriseeventdefinition ee_enterpriseeventde_owner_id_67c5ef56_fk_posthog_u; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.ee_enterpriseeventdefinition
    ADD CONSTRAINT ee_enterpriseeventde_owner_id_67c5ef56_fk_posthog_u FOREIGN KEY (owner_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: ee_enterpriseeventdefinition ee_enterpriseeventde_updated_by_id_7aede29e_fk_posthog_u; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.ee_enterpriseeventdefinition
    ADD CONSTRAINT ee_enterpriseeventde_updated_by_id_7aede29e_fk_posthog_u FOREIGN KEY (updated_by_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: ee_enterprisepropertydefinition ee_enterprisepropert_propertydefinition_p_27d6057a_fk_posthog_p; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.ee_enterprisepropertydefinition
    ADD CONSTRAINT ee_enterprisepropert_propertydefinition_p_27d6057a_fk_posthog_p FOREIGN KEY (propertydefinition_ptr_id) REFERENCES public.posthog_propertydefinition(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: ee_enterprisepropertydefinition ee_enterprisepropert_updated_by_id_96e0be9d_fk_posthog_u; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.ee_enterprisepropertydefinition
    ADD CONSTRAINT ee_enterprisepropert_updated_by_id_96e0be9d_fk_posthog_u FOREIGN KEY (updated_by_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: ee_hook ee_hook_team_id_638d0223_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.ee_hook
    ADD CONSTRAINT ee_hook_team_id_638d0223_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: ee_hook ee_hook_user_id_442b7c5d_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.ee_hook
    ADD CONSTRAINT ee_hook_user_id_442b7c5d_fk_posthog_user_id FOREIGN KEY (user_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_action posthog_action_created_by_id_4e7145d9_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_action
    ADD CONSTRAINT posthog_action_created_by_id_4e7145d9_fk_posthog_user_id FOREIGN KEY (created_by_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_action_events posthog_action_events_action_id_f6f1f077_fk_posthog_action_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_action_events
    ADD CONSTRAINT posthog_action_events_action_id_f6f1f077_fk_posthog_action_id FOREIGN KEY (action_id) REFERENCES public.posthog_action(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_action_events posthog_action_events_event_id_7077ea70_fk_posthog_event_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_action_events
    ADD CONSTRAINT posthog_action_events_event_id_7077ea70_fk_posthog_event_id FOREIGN KEY (event_id) REFERENCES public.posthog_event(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_action posthog_action_team_id_3a21e3a6_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_action
    ADD CONSTRAINT posthog_action_team_id_3a21e3a6_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_actionstep posthog_actionstep_action_id_b50d75e6_fk_posthog_action_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_actionstep
    ADD CONSTRAINT posthog_actionstep_action_id_b50d75e6_fk_posthog_action_id FOREIGN KEY (action_id) REFERENCES public.posthog_action(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_annotation posthog_annotation_created_by_id_1b9c9223_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_annotation
    ADD CONSTRAINT posthog_annotation_created_by_id_1b9c9223_fk_posthog_user_id FOREIGN KEY (created_by_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_annotation posthog_annotation_dashboard_item_id_8bfb9aa9_fk_posthog_d; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_annotation
    ADD CONSTRAINT posthog_annotation_dashboard_item_id_8bfb9aa9_fk_posthog_d FOREIGN KEY (dashboard_item_id) REFERENCES public.posthog_dashboarditem(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_annotation posthog_annotation_organization_id_f5c9d877_fk_posthog_o; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_annotation
    ADD CONSTRAINT posthog_annotation_organization_id_f5c9d877_fk_posthog_o FOREIGN KEY (organization_id) REFERENCES public.posthog_organization(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_annotation posthog_annotation_team_id_95adb263_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_annotation
    ADD CONSTRAINT posthog_annotation_team_id_95adb263_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_cohort posthog_cohort_created_by_id_e003077a_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_cohort
    ADD CONSTRAINT posthog_cohort_created_by_id_e003077a_fk_posthog_user_id FOREIGN KEY (created_by_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_cohort posthog_cohort_team_id_8a849f3d_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_cohort
    ADD CONSTRAINT posthog_cohort_team_id_8a849f3d_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_cohortpeople posthog_cohortpeople_cohort_id_1f371733_fk_posthog_cohort_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_cohortpeople
    ADD CONSTRAINT posthog_cohortpeople_cohort_id_1f371733_fk_posthog_cohort_id FOREIGN KEY (cohort_id) REFERENCES public.posthog_cohort(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_cohortpeople posthog_cohortpeople_person_id_33da7d3f_fk_posthog_person_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_cohortpeople
    ADD CONSTRAINT posthog_cohortpeople_person_id_33da7d3f_fk_posthog_person_id FOREIGN KEY (person_id) REFERENCES public.posthog_person(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_dashboard posthog_dashboard_created_by_id_a528d2ca_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_dashboard
    ADD CONSTRAINT posthog_dashboard_created_by_id_a528d2ca_fk_posthog_user_id FOREIGN KEY (created_by_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_dashboard posthog_dashboard_team_id_5c28ee1a_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_dashboard
    ADD CONSTRAINT posthog_dashboard_team_id_5c28ee1a_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_dashboarditem posthog_dashboardite_dashboard_id_59e2811f_fk_posthog_d; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_dashboarditem
    ADD CONSTRAINT posthog_dashboardite_dashboard_id_59e2811f_fk_posthog_d FOREIGN KEY (dashboard_id) REFERENCES public.posthog_dashboard(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_dashboarditem posthog_dashboardite_dive_dashboard_id_9ba0b080_fk_posthog_d; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_dashboarditem
    ADD CONSTRAINT posthog_dashboardite_dive_dashboard_id_9ba0b080_fk_posthog_d FOREIGN KEY (dive_dashboard_id) REFERENCES public.posthog_dashboard(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_dashboarditem posthog_dashboarditem_created_by_id_a3c81ce2_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_dashboarditem
    ADD CONSTRAINT posthog_dashboarditem_created_by_id_a3c81ce2_fk_posthog_user_id FOREIGN KEY (created_by_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_dashboarditem posthog_dashboarditem_team_id_a0e4bed0_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_dashboarditem
    ADD CONSTRAINT posthog_dashboarditem_team_id_a0e4bed0_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_element posthog_element_event_id_bb6549a0_fk_posthog_event_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_element
    ADD CONSTRAINT posthog_element_event_id_bb6549a0_fk_posthog_event_id FOREIGN KEY (event_id) REFERENCES public.posthog_event(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_element posthog_element_group_id_09134876_fk_posthog_elementgroup_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_element
    ADD CONSTRAINT posthog_element_group_id_09134876_fk_posthog_elementgroup_id FOREIGN KEY (group_id) REFERENCES public.posthog_elementgroup(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_elementgroup posthog_elementgroup_team_id_3ced0286_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_elementgroup
    ADD CONSTRAINT posthog_elementgroup_team_id_3ced0286_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_event posthog_event_team_id_a8b4c6dc_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_event
    ADD CONSTRAINT posthog_event_team_id_a8b4c6dc_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_eventdefinition posthog_eventdefinition_team_id_818ed0f2_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_eventdefinition
    ADD CONSTRAINT posthog_eventdefinition_team_id_818ed0f2_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_featureflag posthog_featureflag_created_by_id_4571fe1a_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_featureflag
    ADD CONSTRAINT posthog_featureflag_created_by_id_4571fe1a_fk_posthog_user_id FOREIGN KEY (created_by_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_featureflag posthog_featureflag_team_id_51e383b9_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_featureflag
    ADD CONSTRAINT posthog_featureflag_team_id_51e383b9_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_organizationinvite posthog_organization_created_by_id_16cbc2ef_fk_posthog_u; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_organizationinvite
    ADD CONSTRAINT posthog_organization_created_by_id_16cbc2ef_fk_posthog_u FOREIGN KEY (created_by_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_organizationinvite posthog_organization_organization_id_15e2bab4_fk_posthog_o; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_organizationinvite
    ADD CONSTRAINT posthog_organization_organization_id_15e2bab4_fk_posthog_o FOREIGN KEY (organization_id) REFERENCES public.posthog_organization(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_organizationmembership posthog_organization_organization_id_6f92360d_fk_posthog_o; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_organizationmembership
    ADD CONSTRAINT posthog_organization_organization_id_6f92360d_fk_posthog_o FOREIGN KEY (organization_id) REFERENCES public.posthog_organization(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_organizationmembership posthog_organization_user_id_aab9f3c7_fk_posthog_u; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_organizationmembership
    ADD CONSTRAINT posthog_organization_user_id_aab9f3c7_fk_posthog_u FOREIGN KEY (user_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_person posthog_person_is_user_id_cfc91ae7_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_person
    ADD CONSTRAINT posthog_person_is_user_id_cfc91ae7_fk_posthog_user_id FOREIGN KEY (is_user_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_person posthog_person_team_id_325c1b73_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_person
    ADD CONSTRAINT posthog_person_team_id_325c1b73_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_personalapikey posthog_personalapikey_team_id_813f490c_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_personalapikey
    ADD CONSTRAINT posthog_personalapikey_team_id_813f490c_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_personalapikey posthog_personalapikey_user_id_730a29e7_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_personalapikey
    ADD CONSTRAINT posthog_personalapikey_user_id_730a29e7_fk_posthog_user_id FOREIGN KEY (user_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_persondistinctid posthog_persondistin_person_id_5d655bba_fk_posthog_p; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_persondistinctid
    ADD CONSTRAINT posthog_persondistin_person_id_5d655bba_fk_posthog_p FOREIGN KEY (person_id) REFERENCES public.posthog_person(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_persondistinctid posthog_persondistinctid_team_id_46330ec9_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_persondistinctid
    ADD CONSTRAINT posthog_persondistinctid_team_id_46330ec9_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_plugin posthog_plugin_organization_id_d040b9a9_fk_posthog_o; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_plugin
    ADD CONSTRAINT posthog_plugin_organization_id_d040b9a9_fk_posthog_o FOREIGN KEY (organization_id) REFERENCES public.posthog_organization(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_pluginattachment posthog_pluginattach_plugin_config_id_cc94a1b9_fk_posthog_p; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginattachment
    ADD CONSTRAINT posthog_pluginattach_plugin_config_id_cc94a1b9_fk_posthog_p FOREIGN KEY (plugin_config_id) REFERENCES public.posthog_pluginconfig(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_pluginattachment posthog_pluginattachment_team_id_415eacc7_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginattachment
    ADD CONSTRAINT posthog_pluginattachment_team_id_415eacc7_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_pluginconfig posthog_pluginconfig_plugin_id_d014ca1c_fk_posthog_plugin_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginconfig
    ADD CONSTRAINT posthog_pluginconfig_plugin_id_d014ca1c_fk_posthog_plugin_id FOREIGN KEY (plugin_id) REFERENCES public.posthog_plugin(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_pluginconfig posthog_pluginconfig_team_id_71185766_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginconfig
    ADD CONSTRAINT posthog_pluginconfig_team_id_71185766_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_pluginlogentry posthog_pluginlogent_plugin_config_id_2fe30023_fk_posthog_p; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginlogentry
    ADD CONSTRAINT posthog_pluginlogent_plugin_config_id_2fe30023_fk_posthog_p FOREIGN KEY (plugin_config_id) REFERENCES public.posthog_pluginconfig(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_pluginlogentry posthog_pluginlogentry_plugin_id_42aaf74e_fk_posthog_plugin_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginlogentry
    ADD CONSTRAINT posthog_pluginlogentry_plugin_id_42aaf74e_fk_posthog_plugin_id FOREIGN KEY (plugin_id) REFERENCES public.posthog_plugin(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_pluginlogentry posthog_pluginlogentry_team_id_5cab32b2_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginlogentry
    ADD CONSTRAINT posthog_pluginlogentry_team_id_5cab32b2_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_pluginstorage posthog_pluginstorag_plugin_config_id_6744363a_fk_posthog_p; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_pluginstorage
    ADD CONSTRAINT posthog_pluginstorag_plugin_config_id_6744363a_fk_posthog_p FOREIGN KEY (plugin_config_id) REFERENCES public.posthog_pluginconfig(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_propertydefinition posthog_propertydefinition_team_id_b7abe702_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_propertydefinition
    ADD CONSTRAINT posthog_propertydefinition_team_id_b7abe702_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_sessionrecordingviewed posthog_sessionrecor_team_id_5d0d59b9_fk_posthog_t; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_sessionrecordingviewed
    ADD CONSTRAINT posthog_sessionrecor_team_id_5d0d59b9_fk_posthog_t FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_sessionrecordingevent posthog_sessionrecor_team_id_974f0e0d_fk_posthog_t; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_sessionrecordingevent
    ADD CONSTRAINT posthog_sessionrecor_team_id_974f0e0d_fk_posthog_t FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_sessionrecordingviewed posthog_sessionrecor_user_id_ef83047a_fk_posthog_u; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_sessionrecordingviewed
    ADD CONSTRAINT posthog_sessionrecor_user_id_ef83047a_fk_posthog_u FOREIGN KEY (user_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_sessionsfilter posthog_sessionsfilt_created_by_id_06700ae9_fk_posthog_u; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_sessionsfilter
    ADD CONSTRAINT posthog_sessionsfilt_created_by_id_06700ae9_fk_posthog_u FOREIGN KEY (created_by_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_sessionsfilter posthog_sessionsfilter_team_id_59837f38_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_sessionsfilter
    ADD CONSTRAINT posthog_sessionsfilter_team_id_59837f38_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_team posthog_team_organization_id_41bbc1d0_fk_posthog_o; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_team
    ADD CONSTRAINT posthog_team_organization_id_41bbc1d0_fk_posthog_o FOREIGN KEY (organization_id) REFERENCES public.posthog_organization(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_team_users posthog_team_users_team_id_2bd01272_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_team_users
    ADD CONSTRAINT posthog_team_users_team_id_2bd01272_fk_posthog_team_id FOREIGN KEY (team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_team_users posthog_team_users_user_id_c7bafb47_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_team_users
    ADD CONSTRAINT posthog_team_users_user_id_c7bafb47_fk_posthog_user_id FOREIGN KEY (user_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_user posthog_user_current_organization_e8527570_fk_posthog_o; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user
    ADD CONSTRAINT posthog_user_current_organization_e8527570_fk_posthog_o FOREIGN KEY (current_organization_id) REFERENCES public.posthog_organization(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_user posthog_user_current_team_id_52760528_fk_posthog_team_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user
    ADD CONSTRAINT posthog_user_current_team_id_52760528_fk_posthog_team_id FOREIGN KEY (current_team_id) REFERENCES public.posthog_team(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_user_groups posthog_user_groups_group_id_75d77987_fk_auth_group_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user_groups
    ADD CONSTRAINT posthog_user_groups_group_id_75d77987_fk_auth_group_id FOREIGN KEY (group_id) REFERENCES public.auth_group(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_user_groups posthog_user_groups_user_id_6b000a50_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user_groups
    ADD CONSTRAINT posthog_user_groups_user_id_6b000a50_fk_posthog_user_id FOREIGN KEY (user_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_user_user_permissions posthog_user_user_pe_permission_id_21270994_fk_auth_perm; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user_user_permissions
    ADD CONSTRAINT posthog_user_user_pe_permission_id_21270994_fk_auth_perm FOREIGN KEY (permission_id) REFERENCES public.auth_permission(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: posthog_user_user_permissions posthog_user_user_pe_user_id_f94166b7_fk_posthog_u; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.posthog_user_user_permissions
    ADD CONSTRAINT posthog_user_user_pe_user_id_f94166b7_fk_posthog_u FOREIGN KEY (user_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: rest_hooks_hook rest_hooks_hook_user_id_94046fce_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.rest_hooks_hook
    ADD CONSTRAINT rest_hooks_hook_user_id_94046fce_fk_posthog_user_id FOREIGN KEY (user_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: social_auth_usersocialauth social_auth_usersocialauth_user_id_17d28448_fk_posthog_user_id; Type: FK CONSTRAINT; Schema: public; Owner: posthog
--

ALTER TABLE ONLY public.social_auth_usersocialauth
    ADD CONSTRAINT social_auth_usersocialauth_user_id_17d28448_fk_posthog_user_id FOREIGN KEY (user_id) REFERENCES public.posthog_user(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: job_queues; Type: ROW SECURITY; Schema: graphile_worker; Owner: posthog
--

ALTER TABLE graphile_worker.job_queues ENABLE ROW LEVEL SECURITY;

--
-- Name: jobs; Type: ROW SECURITY; Schema: graphile_worker; Owner: posthog
--

ALTER TABLE graphile_worker.jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: known_crontabs; Type: ROW SECURITY; Schema: graphile_worker; Owner: posthog
--

ALTER TABLE graphile_worker.known_crontabs ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

