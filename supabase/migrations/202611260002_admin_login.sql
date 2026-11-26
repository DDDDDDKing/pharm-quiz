begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table pharm.admin_logins (
  username text primary key check (username ~ '^[a-z0-9_.-]{1,40}$'),
  account_id uuid not null unique references pharm.accounts(id),
  password_hash text not null,
  failed_attempts integer not null default 0,
  window_start timestamptz not null default now()
);

create table pharm.admin_sessions (
  token_hash bytea primary key,
  account_id uuid not null references pharm.accounts(id),
  expires_at timestamptz not null
);

alter table pharm.admin_logins enable row level security;
alter table pharm.admin_sessions enable row level security;

-- Provision from the SQL editor using an offline-generated bcrypt hash.
create function pharm.configure_admin(p_username text, p_password_hash text)
returns void language plpgsql security invoker set search_path = '' as $$
declare
  admin_id uuid;
begin
  if p_username is null or p_username !~ '^[a-z0-9_.-]{1,40}$'
    or p_password_hash is null or p_password_hash !~ '^\$2a\$12\$[./A-Za-z0-9]{53}$' then
    raise exception 'Invalid administrator name or bcrypt hash';
  end if;
  select account_id into admin_id from pharm.admin_logins where username = p_username for update;
  if not found then
    insert into pharm.accounts(credential_hash,hint,label,role)
      values (sha256(convert_to(gen_random_uuid()::text,'UTF8')), '', p_username, 'admin')
      returning id into admin_id;
  end if;
  insert into pharm.admin_logins(username,account_id,password_hash)
    values (p_username, admin_id, p_password_hash)
    on conflict (username) do update set
      password_hash = excluded.password_hash, failed_attempts = 0, window_start = now();
  delete from pharm.admin_sessions where account_id = admin_id;
end;
$$;

create function public.pharm_quiz_admin_sign_in(p_username text, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  login pharm.admin_logins%rowtype;
  token text;
begin
  select l.* into login from pharm.admin_logins l join pharm.accounts a on a.id = l.account_id
    where l.username = p_username and a.active and a.role = 'admin' for update of l;
  if not found then return '{"error":"invalid_admin_login"}'::jsonb; end if;
  if login.window_start <= now() - interval '15 minutes' then
    login.failed_attempts := 0;
    login.window_start := now();
  end if;
  if login.failed_attempts >= 8 then return '{"error":"auth_rate_limit"}'::jsonb; end if;
  if extensions.crypt(p_password, login.password_hash) is distinct from login.password_hash then
    update pharm.admin_logins set failed_attempts = login.failed_attempts + 1,
      window_start = login.window_start where username = p_username;
    return '{"error":"invalid_admin_login"}'::jsonb;
  end if;
  update pharm.admin_logins set failed_attempts = 0, window_start = now() where username = p_username;
  delete from pharm.admin_sessions where expires_at <= now();
  token := gen_random_uuid()::text;
  insert into pharm.admin_sessions(token_hash,account_id,expires_at)
    values (sha256(convert_to(token,'UTF8')),login.account_id,now() + interval '8 hours');
  return jsonb_build_object('token', token);
end;
$$;

create function public.pharm_quiz_admin_session(p_token text, p_end boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  stored_hash bytea := sha256(convert_to(p_token, 'UTF8'));
  account_hash bytea;
begin
  if p_end then
    delete from pharm.admin_sessions where token_hash = stored_hash;
    return '{"ok":true}'::jsonb;
  end if;
  select a.credential_hash into account_hash from pharm.admin_sessions s
    join pharm.accounts a on a.id = s.account_id and a.active and a.role = 'admin'
    where s.token_hash = stored_hash and s.expires_at > now();
  if not found then return '{"error":"access_denied"}'::jsonb; end if;
  return jsonb_build_object('hash', encode(account_hash,'hex'));
end;
$$;

revoke all on function pharm.configure_admin(text,text) from public, anon, authenticated, service_role;
revoke all on function public.pharm_quiz_admin_sign_in(text,text), public.pharm_quiz_admin_session(text,boolean)
  from public, anon, authenticated;
grant execute on function public.pharm_quiz_admin_sign_in(text,text), public.pharm_quiz_admin_session(text,boolean)
  to service_role;
notify pgrst, 'reload schema';
commit;
