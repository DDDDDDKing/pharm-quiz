begin;

alter table pharm.accounts
  add column auth_user_id uuid unique references auth.users(id),
  add column progress_key uuid not null default gen_random_uuid(),
  add column public_nickname text not null
    default ('学员' || lpad(floor(random() * 10000)::integer::text, 4, '0'))
    check (char_length(public_nickname) between 1 and 40);

create table pharm.purchase_orders (
  number text primary key check (number ~ '^[0-9]{15,24}$'),
  kind text not null check (kind in ('registration', 'ai')),
  account_id uuid not null references pharm.accounts(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index purchase_orders_review on pharm.purchase_orders(status, submitted_at desc, number desc);

create table pharm.signup_reservations (
  email text primary key,
  source_hash bytea not null unique,
  legacy boolean not null,
  order_number text unique,
  check (legacy = (order_number is null)),
  nickname text not null check (char_length(nickname) <= 40),
  ticket uuid not null unique default gen_random_uuid(),
  expires_at timestamptz not null,
  last_send_at timestamptz not null
);

alter table pharm.purchase_orders enable row level security;
alter table pharm.signup_reservations enable row level security;

-- Credentials and pending registrations can only be managed by the Edge Function.
create function public.pharm_quiz_reserve_signup(p_email text, p_hash text, p_legacy boolean, p_nickname text, p_order text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  source bytea := decode(p_hash, 'hex');
  pending pharm.signup_reservations%rowtype;
begin
  -- Serialize reservation and redemption; no network calls occur under this lock.
  perform pg_advisory_xact_lock(7412100001);
  if p_legacy then
    if not exists (select from pharm.accounts where credential_hash = source and role = 'student'
      and active and auth_user_id is null) then
      return '{"error":"invalid_legacy_id"}'::jsonb;
    end if;
  elsif p_order is null or p_order !~ '^[0-9]{15,24}$' then
    return '{"error":"invalid_order"}'::jsonb;
  elsif exists (select from pharm.purchase_orders where number = p_order) then
    return '{"error":"order_in_use"}'::jsonb;
  end if;

  if exists (
    select from pharm.accounts a join auth.users u on u.id = a.auth_user_id
    where lower(u.email) = p_email
  ) then
    return '{"error":"already_registered"}'::jsonb;
  end if;

  delete from pharm.signup_reservations where expires_at <= now();
  select * into pending from pharm.signup_reservations where email = p_email;
  if found and (pending.source_hash <> source or pending.legacy <> p_legacy) then
    return '{"error":"email_reserved"}'::jsonb;
  end if;
  if exists (select from pharm.signup_reservations where source_hash = source and email <> p_email) then
    return '{"error":"key_reserved"}'::jsonb;
  end if;
  if pending.last_send_at > now() - interval '1 minute' then
    return '{"error":"email_rate_limit"}'::jsonb;
  end if;

  insert into pharm.signup_reservations(email, source_hash, legacy, order_number, nickname, expires_at, last_send_at)
    values (p_email, source, p_legacy, p_order, p_nickname, now() + interval '1 hour', now())
    on conflict (email) do update set
      nickname = excluded.nickname, expires_at = excluded.expires_at, last_send_at = excluded.last_send_at
    returning * into pending;

  return jsonb_build_object('ticket', pending.ticket);
end;
$$;

create function public.pharm_quiz_signup_hook(event jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if event #>> '{user,app_metadata,provider}' = 'email' and exists (
    select from pharm.signup_reservations r
    where r.email = lower(event #>> '{user,email}')
      and r.ticket::text = event #>> '{user,user_metadata,pharm_signup_ticket}'
      and r.expires_at > now()
  ) then
    return '{}'::jsonb;
  end if;
  return '{"error":{"http_code":403,"message":"A valid Pharm Quiz registration reservation is required."}}'::jsonb;
end;
$$;

create function public.pharm_quiz_resolve_student(p_user uuid, p_activate boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  learner pharm.accounts%rowtype;
  pending pharm.signup_reservations%rowtype;
  verified_email text;
begin
  select * into learner from pharm.accounts where auth_user_id = p_user;
  if not found and p_activate then
    perform pg_advisory_xact_lock(7412100001);
    select * into learner from pharm.accounts where auth_user_id = p_user;
    if not found then
      select lower(email) into verified_email from auth.users
        where id = p_user and email_confirmed_at is not null and not is_anonymous;
      select * into pending from pharm.signup_reservations where email = verified_email and expires_at > now();
      if not found then return '{"error":"registration_required"}'::jsonb; end if;

      if pending.legacy then
        update pharm.accounts
          set auth_user_id = p_user, public_nickname = coalesce(nullif(pending.nickname, ''), public_nickname)
          where credential_hash = pending.source_hash and role = 'student' and active and auth_user_id is null
          returning * into learner;
        if not found then return '{"error":"invalid_legacy_id"}'::jsonb; end if;
      else
        if exists (select from pharm.purchase_orders where number = pending.order_number) then
          return '{"error":"order_in_use"}'::jsonb;
        end if;
        insert into pharm.accounts(credential_hash, hint, label, role, auth_user_id, public_nickname)
          select sha256(convert_to(gen_random_uuid()::text, 'UTF8')), '', name, 'student', p_user, name
          from (select coalesce(nullif(pending.nickname, ''),
            '学员' || lpad(floor(random() * 10000)::integer::text, 4, '0')) as name) alias
          returning * into learner;
        insert into pharm.purchase_orders(number, kind, account_id)
          values (pending.order_number, 'registration', learner.id);
      end if;
      delete from pharm.signup_reservations where email = pending.email;
    end if;
  end if;

  if learner.id is null or learner.role <> 'student' or not learner.active then
    return '{"error":"access_denied"}'::jsonb;
  end if;
  return jsonb_build_object('hash', encode(learner.credential_hash, 'hex'),
    'nickname', learner.public_nickname, 'progressKey', learner.progress_key);
end;
$$;

create function public.pharm_quiz_submit_ai_order(p_user uuid, p_number text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  learner uuid;
  existing pharm.purchase_orders%rowtype;
begin
  if p_number is null or p_number !~ '^[0-9]{15,24}$' then
    return '{"error":"invalid_order"}'::jsonb;
  end if;
  perform pg_advisory_xact_lock(7412100001);
  select id into learner from pharm.accounts where auth_user_id = p_user and role = 'student' and active for update;
  if not found then return '{"error":"access_denied"}'::jsonb; end if;
  select * into existing from pharm.purchase_orders where number = p_number;
  if found then
    if existing.kind = 'ai' and existing.account_id = learner then
      return jsonb_build_object('status', existing.status);
    end if;
    return '{"error":"order_in_use"}'::jsonb;
  end if;
  if exists (select from pharm.signup_reservations where order_number = p_number and expires_at > now()) then
    return '{"error":"order_in_use"}'::jsonb;
  end if;
  insert into pharm.purchase_orders(number, kind, account_id) values (p_number, 'ai', learner);
  return '{"status":"pending"}'::jsonb;
end;
$$;

create function public.pharm_quiz_orders(p_hash text, p_action text, p_body jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  entry pharm.purchase_orders%rowtype;
  decision text;
  rows jsonb;
begin
  if not exists (select from pharm.accounts where credential_hash = decode(p_hash, 'hex')
    and role = 'admin' and active) then
    return '{"error":"access_denied"}'::jsonb;
  end if;

  if p_action = 'review_order' then
    decision := p_body->>'status';
    if decision not in ('approved', 'rejected') or decision is null then
      return '{"error":"invalid_request"}'::jsonb;
    end if;
    select * into entry from pharm.purchase_orders where number = p_body->>'number' for update;
    if not found then return '{"error":"not_found"}'::jsonb; end if;
    if entry.status = decision then return '{"ok":true}'::jsonb; end if;
    if entry.status <> 'pending' then return '{"error":"already_reviewed"}'::jsonb; end if;
    if entry.kind = 'ai' and decision = 'approved' then
      update pharm.accounts set ai_balance = ai_balance + 100 where id = entry.account_id;
    elsif entry.kind = 'registration' and decision = 'rejected' then
      update pharm.accounts set active = false where id = entry.account_id;
    end if;
    update pharm.purchase_orders set status = decision, reviewed_at = now() where number = entry.number;
    return '{"ok":true}'::jsonb;
  end if;

  if p_action <> 'list_orders' then return '{"error":"invalid_request"}'::jsonb; end if;
  select coalesce(jsonb_agg(row_view order by row_view.submitted_at desc, row_view.number desc), '[]'::jsonb) into rows
    from (
      select o.number, o.kind, o.status, o.submitted_at, o.reviewed_at, a.public_nickname as nickname,
        u.email, a.active
      from pharm.purchase_orders o join pharm.accounts a on a.id = o.account_id
      left join auth.users u on u.id = a.auth_user_id
      where o.status = p_body->>'status'
      order by o.submitted_at desc, o.number desc
      offset (p_body->>'page')::integer * 25 limit 26
    ) row_view;
  return jsonb_build_object('orders', rows);
end;
$$;

revoke all on function public.pharm_quiz_reserve_signup(text,text,boolean,text,text),
  public.pharm_quiz_resolve_student(uuid,boolean), public.pharm_quiz_submit_ai_order(uuid,text),
  public.pharm_quiz_orders(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.pharm_quiz_reserve_signup(text,text,boolean,text,text),
  public.pharm_quiz_resolve_student(uuid,boolean), public.pharm_quiz_submit_ai_order(uuid,text),
  public.pharm_quiz_orders(text,text,jsonb) to service_role;
revoke all on function public.pharm_quiz_signup_hook(jsonb) from public, anon, authenticated;
grant execute on function public.pharm_quiz_signup_hook(jsonb) to supabase_auth_admin;

create or replace function public.pharm_quiz_comments(p_hash text, p_action text, p_body jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  learner uuid;
  question text := p_body->>'question';
  scope text := p_body->>'scope';
  target uuid;
  result jsonb;
begin
  select id into learner from pharm.accounts
    where credential_hash = decode(p_hash,'hex') and role='student' and active;
  if learner is null then return '{"error":"access_denied"}'::jsonb; end if;

  if p_action = 'comment_save' then
    if not exists (select from pharm.questions where id=question) then return '{"error":"not_found"}'::jsonb; end if;
    insert into pharm.comments as c (author_id,question_id,body)
      values (learner,question,p_body->>'text')
      on conflict (author_id,question_id) do update set
        body=excluded.body, updated_at=case when c.body=excluded.body then c.updated_at else now() end;
    return '{"ok":true}'::jsonb;
  end if;

  if p_action = 'comment_delete' then
    delete from pharm.comments where author_id=learner and question_id=question;
    return '{"ok":true}'::jsonb;
  end if;

  if p_action = 'comment_bookmark' then
    target := (p_body->>'comment')::uuid;
    if (p_body->>'saved')::boolean then
      insert into pharm.comment_bookmarks(learner_id,comment_id)
        select learner,c.id from pharm.comments c join pharm.accounts a on a.id=c.author_id
        where c.id=target and c.author_id<>learner and a.active for key share of c
        on conflict do nothing;
    else
      delete from pharm.comment_bookmarks where learner_id=learner and comment_id=target;
    end if;
    return '{"ok":true}'::jsonb;
  end if;

  if p_action <> 'comments' then return '{"error":"invalid_request"}'::jsonb; end if;
  select coalesce(jsonb_agg(to_jsonb(entries) - 'sort_at' order by entries.sort_at desc, entries.id desc),'[]'::jsonb)
    into result from (
      select c.id,c.question_id as question,c.body as text,c.updated_at as "updatedAt",
        c.author_id=learner as mine,b.comment_id is not null as saved,
        author.public_nickname as "authorName",
        left(replace(c.author_id::text,'-',''),10) as "authorTag",
        case when scope='saved' then b.created_at else c.created_at end as sort_at
      from pharm.comments c
      join pharm.accounts author on author.id=c.author_id and author.active
      left join pharm.comment_bookmarks b on b.comment_id=c.id and b.learner_id=learner
      where (question is null or c.question_id=question)
        and (scope='all' or (scope='mine' and c.author_id=learner) or (scope='saved' and b.comment_id is not null))
      order by sort_at desc,c.id desc
      offset coalesce((p_body->>'page')::integer,0)*25 limit 26
    ) entries;
  return jsonb_build_object('items',result,'mine',
    (select c.body from pharm.comments c where c.author_id=learner and c.question_id=question));
end;
$$;

notify pgrst, 'reload schema';
commit;
