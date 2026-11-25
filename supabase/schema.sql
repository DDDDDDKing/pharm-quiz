create schema if not exists pharm;
revoke all on schema pharm from public, anon, authenticated;
grant usage on schema pharm to service_role;

create function pharm.empty_progress() returns jsonb
language sql immutable set search_path = '' as $$
  select '{"rec":{},"fav":[],"wrong":[],"pos":{},"hist":{},"autonext":false,"theme":"light","exam":null,"notes":{},"marked":{},"mastered":{},"clearedAt":{}}'::jsonb
$$;

create table pharm.accounts (
  id uuid primary key default gen_random_uuid(),
  credential_hash bytea not null unique,
  hint text not null,
  label text not null check (char_length(label) between 1 and 80),
  role text not null check (role in ('student', 'admin')),
  active boolean not null default true,
  state jsonb not null default pharm.empty_progress(),
  epoch integer not null default 0,
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  last_seen timestamptz
);
create table pharm.events (
  account_id uuid not null references pharm.accounts(id) on delete cascade,
  id uuid not null,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  primary key (account_id, id)
);
create table pharm.sections (
  id boolean primary key default true check (id),
  data jsonb not null
);
create table pharm.questions (
  id text primary key,
  data jsonb not null
);

alter table pharm.accounts enable row level security;
alter table pharm.events enable row level security;
alter table pharm.sections enable row level security;
alter table pharm.questions enable row level security;
grant select, insert, update on pharm.accounts to service_role;
grant select, insert, delete on pharm.events to service_role;
grant select on pharm.questions, pharm.sections to service_role;

create function pharm.membership(items jsonb, changes jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  question_id text;
  enabled jsonb;
begin
  for question_id, enabled in select key, value from jsonb_each(coalesce(changes, '{}'::jsonb)) loop
    if enabled = 'true'::jsonb then
      if not items ? question_id then items := items || to_jsonb(question_id); end if;
    else
      items := items - question_id;
    end if;
  end loop;
  return items;
end;
$$;

create function public.pharm_quiz_student(p_hash text, p_action text, p_body jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
<<progress>>
declare
  account pharm.accounts%rowtype;
  batch jsonb := coalesce(p_body->'events', '[]'::jsonb);
  event jsonb;
  attempt jsonb;
  patch jsonb;
  state jsonb;
  question jsonb;
  question_id text;
  answer_day text;
  selection jsonb;
  counter jsonb;
  daily jsonb;
  days jsonb;
  day_key text;
  removed_count jsonb;
  clear_at bigint;
  stale_wrong text[];

  is_correct integer;
  new_rows integer;
  epoch integer;
  changed boolean := false;
  result jsonb;
begin
  select * into account from pharm.accounts
    where credential_hash = decode(p_hash, 'hex') and role = 'student' and active
    for update;
  if not found then return '{"error":"access_denied"}'::jsonb; end if;

  state := account.state;
  epoch := account.epoch;
  if p_action = 'sync' and (p_body->>'epoch')::integer = epoch then
    for event in select value from jsonb_array_elements(batch) loop
      insert into pharm.events (account_id, id, payload)
        values (account.id, (event->>'id')::uuid, event)
        on conflict do nothing;
      get diagnostics new_rows = row_count;
      if new_rows = 0 then continue; end if;
      changed := true;

      if event->'reset' = 'true'::jsonb then
        delete from pharm.events where account_id = account.id and id <> (event->>'id')::uuid;
        state := pharm.empty_progress();
        epoch := epoch + 1;
        exit;
      end if;

      patch := coalesce(event->'patch', '{}'::jsonb);
      stale_wrong := array[]::text[];
      if patch ? 'clearQuestions' then
        clear_at := (patch#>>'{clearQuestions,at}')::bigint;
        state := jsonb_set(state, '{clearedAt}', coalesce(state->'clearedAt','{}'::jsonb));
        for question_id in select jsonb_array_elements_text(patch#>'{clearQuestions,ids}') loop
          if clear_at < coalesce((state#>>array['clearedAt',question_id])::bigint,0) then continue; end if;
          state := jsonb_set(state,array['clearedAt',question_id],to_jsonb(clear_at));
          counter := state#>array['rec',question_id];
          if coalesce((counter->>'t')::bigint,0) > clear_at then continue; end if;
          for day_key, removed_count in select key,value from jsonb_each(coalesce(counter->'days','{}'::jsonb)) loop
            daily := state#>array['hist',day_key];
            if coalesce((daily->>'n')::integer,0) <= (removed_count->>'n')::integer then
              state := state #- array['hist',day_key];
            else
              state := jsonb_set(state,array['hist',day_key],jsonb_build_object(
                'n',(daily->>'n')::integer-(removed_count->>'n')::integer,
                'ok',greatest(0,(daily->>'ok')::integer-(removed_count->>'ok')::integer)));
            end if;
          end loop;
          state := state #- array['rec',question_id];
          state := jsonb_set(state,'{wrong}',(state->'wrong') - question_id);
        end loop;
      end if;

      for attempt in select value from jsonb_array_elements(coalesce(event->'attempts', '[]'::jsonb)) loop
        question_id := attempt->>'question';
        if (attempt->>'time')::bigint <= coalesce((state#>>array['clearedAt',question_id])::bigint,0) then
          stale_wrong := array_append(stale_wrong,question_id);
          continue;
        end if;
        answer_day := attempt->>'day';
        selection := attempt->'selection';
        select data into question from pharm.questions where id = question_id;
        if question is null then continue; end if;
        is_correct := case when selection = question->'a' then 1 else 0 end;
        counter := coalesce(state#>array['rec',question_id], '{}'::jsonb);
        days := coalesce(counter->'days','{}'::jsonb);
        daily := days->answer_day;
        days := jsonb_set(days,array[answer_day],jsonb_build_object(
          'n',coalesce((daily->>'n')::integer,0)+1,'ok',coalesce((daily->>'ok')::integer,0)+is_correct));
        state := jsonb_set(state, array['rec',question_id], jsonb_build_object(
          'a', coalesce((counter->>'a')::integer,0) + 1,
          'c', coalesce((counter->>'c')::integer,0) + is_correct,
          'w', 1 - is_correct,
          't', attempt->'time',
          'sel', selection,
          'days', days
        ));
        counter := coalesce(state#>array['hist',answer_day], '{}'::jsonb);
        state := jsonb_set(state, array['hist',answer_day], jsonb_build_object(
          'n', coalesce((counter->>'n')::integer,0) + 1,
          'ok', coalesce((counter->>'ok')::integer,0) + is_correct
        ));
      end loop;

      state := jsonb_set(state, '{fav}', pharm.membership(state->'fav',patch->'fav'));
      state := jsonb_set(state, '{wrong}', pharm.membership(state->'wrong',(patch->'wrong') - stale_wrong));
      state := jsonb_set(state, '{pos}', (state->'pos') || coalesce(patch->'pos','{}'::jsonb));
      state := jsonb_set(state, '{notes}', coalesce(state->'notes','{}'::jsonb) || coalesce(patch->'notes','{}'::jsonb));
      state := jsonb_set(state, '{marked}', coalesce(state->'marked','{}'::jsonb) || coalesce(patch->'marked','{}'::jsonb));
      state := jsonb_set(state, '{mastered}', coalesce(state->'mastered','{}'::jsonb) || coalesce(patch->'mastered','{}'::jsonb));
      state := state || (patch - 'fav' - 'wrong' - 'pos' - 'notes' - 'marked' - 'mastered' - 'clearQuestions');
    end loop;
  end if;

  if changed or p_action = 'login' then
    update pharm.accounts set
      last_seen = now(), state = progress.state,
      epoch = progress.epoch, revision = account.revision + changed::integer
      where id = account.id returning * into account;
  end if;

  result := jsonb_build_object('epoch', account.epoch, 'revision', account.revision);
  if p_action = 'login' or coalesce((p_body->>'revision')::bigint, -1) <> account.revision then
    result := result || jsonb_build_object('state', account.state);
  end if;
  if p_action = 'login' then
    result := result || jsonb_build_object('bank', jsonb_build_object(
      'sections', (select data from pharm.sections where id),
      'qs', (select jsonb_agg(data order by (data->>'sec')::integer, (data->>'num')::integer) from pharm.questions)
    ), 'label', account.label);
  end if;
  return result;
end;
$$;

create table pharm.ai_settings (
  id boolean primary key default true check(id),
  provider text not null default 'doubao',
  model text not null default '',
  api_key text not null default '',
  enabled boolean not null default false,
  daily_limit integer not null default 20 check(daily_limit between 1 and 100)
);
insert into pharm.ai_settings(id) values(true);
create table pharm.ai_usage (
  account_id uuid not null references pharm.accounts(id) on delete cascade,
  day date not null,
  count integer not null default 0,
  primary key(account_id,day)
);
alter table pharm.ai_settings enable row level security;
alter table pharm.ai_usage enable row level security;
grant select,update on pharm.ai_settings to service_role;
grant select,insert,update on pharm.ai_usage to service_role;

create or replace function public.pharm_quiz_ai(p_hash text, p_question text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  learner pharm.accounts%rowtype;
  config pharm.ai_settings%rowtype;
  question jsonb;
  used integer;
begin
  select * into learner from pharm.accounts where credential_hash=decode(p_hash,'hex') and role='student' and active for update;
  if not found then return '{"error":"access_denied"}'::jsonb; end if;
  select * into config from pharm.ai_settings where id;
  if not config.enabled or config.api_key='' or config.model='' then return '{"error":"ai_not_configured"}'::jsonb; end if;
  select data into question from pharm.questions where id=p_question;
  if question is null then return '{"error":"not_found"}'::jsonb; end if;
  insert into pharm.ai_usage as usage(account_id,day,count)
    values(learner.id,(now() at time zone 'Asia/Shanghai')::date,1)
    on conflict(account_id,day) do update set count=usage.count+1
    where usage.count<config.daily_limit returning count into used;
  if used is null then return '{"error":"ai_limit"}'::jsonb; end if;
  return jsonb_build_object('provider',config.provider,'model',config.model,'key',config.api_key,'question',question);
end;
$$;
revoke all on function public.pharm_quiz_ai(text,text) from public,anon,authenticated;
grant execute on function public.pharm_quiz_ai(text,text) to service_role;

create table pharm.comments (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references pharm.accounts(id) on delete cascade,
  question_id text not null references pharm.questions(id),
  body text not null check (char_length(body) between 1 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(author_id, question_id)
);
create index comments_by_question on pharm.comments(question_id, created_at desc, id desc);
create table pharm.comment_bookmarks (
  learner_id uuid not null references pharm.accounts(id) on delete cascade,
  comment_id uuid not null references pharm.comments(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key(learner_id, comment_id)
);
create index comment_bookmarks_by_comment on pharm.comment_bookmarks(comment_id);
alter table pharm.comments enable row level security;
alter table pharm.comment_bookmarks enable row level security;
grant select, insert, update, delete on pharm.comments to service_role;
grant select, insert, delete on pharm.comment_bookmarks to service_role;

create function public.pharm_quiz_comments(p_hash text, p_action text, p_body jsonb) returns jsonb
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

revoke all on function public.pharm_quiz_comments(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.pharm_quiz_comments(text,text,jsonb) to service_role;

create function public.pharm_quiz_admin(p_hash text, p_action text, p_body jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  issued text;
  changed_id uuid;
  rows jsonb;
begin
  if not exists (select from pharm.accounts
      where credential_hash = decode(p_hash, 'hex') and role = 'admin' and active) then
    return '{"error":"access_denied"}'::jsonb;
  end if;
  if p_action = 'detail' then
    select jsonb_build_object('label',a.label,'state',a.state,
      'comments',(select coalesce(jsonb_object_agg(c.question_id,c.body),'{}'::jsonb)
        from pharm.comments c where c.author_id=a.id),
      'questions',(select coalesce(jsonb_agg(q.data order by q.id),'[]'::jsonb)
        from pharm.questions q where a.state->'rec' ? q.id or a.state->'notes' ? q.id
          or a.state->'marked' ? q.id or a.state->'mastered' ? q.id
          or exists(select from pharm.comments c where c.author_id=a.id and c.question_id=q.id)),
      'sections',(select data from pharm.sections where id))
      into rows from pharm.accounts a where a.id=(p_body->>'account')::uuid and a.role='student';
    return coalesce(rows,'{"error":"not_found"}'::jsonb);
  end if;
  if p_action = 'ai_save' then
    update pharm.ai_settings set provider=p_body->>'provider', model=p_body->>'model',
      api_key=case when coalesce(p_body->>'apiKey','')<>'' then p_body->>'apiKey'
        when provider=p_body->>'provider' then api_key else '' end,
      enabled=(p_body->>'enabled')::boolean, daily_limit=(p_body->>'dailyLimit')::integer
      where id;
  end if;
  if p_action in ('ai_save','ai_settings') then
    select jsonb_build_object('provider',provider,'model',model,'enabled',enabled,
      'hasKey',api_key<>'','dailyLimit',daily_limit) into rows from pharm.ai_settings where id;
    return rows;
  end if;
  if p_action = 'add' then
    issued := p_body->>'student_id';
    if issued is null or char_length(issued) not between 1 and 128 then
      return '{"error":"invalid_request"}'::jsonb;
    end if;
    insert into pharm.accounts (credential_hash, hint, label, role)
      values (sha256(convert_to(issued,'UTF8')), right(issued,least(4, char_length(issued)-1)), p_body->>'label', 'student')
      on conflict (credential_hash) do nothing
      returning id into changed_id;
    if changed_id is null then return '{"error":"id_in_use"}'::jsonb; end if;
    return jsonb_build_object('credential', issued, 'id', changed_id);
  end if;
  if p_action = 'set_active' then
    update pharm.accounts set active = (p_body->>'active')::boolean
      where id = (p_body->>'account')::uuid and role = 'student' returning id into changed_id;
    if changed_id is null then return '{"error":"not_found"}'::jsonb; end if;
    return '{"ok":true}'::jsonb;
  end if;

  select coalesce(jsonb_agg(row_view order by row_view.created_at desc), '[]'::jsonb) into rows
  from (
    select a.id, a.hint, a.label, a.active, a.created_at, a.last_seen,
      metrics.distinct_questions, metrics.attempts, metrics.correct,
      jsonb_array_length(a.state->'wrong') as wrong,
      jsonb_array_length(a.state->'fav') as favorites
    from pharm.accounts a
    cross join lateral (
      select count(*) as distinct_questions,
        coalesce(sum((value->>'a')::bigint), 0) as attempts,
        coalesce(sum((value->>'c')::bigint), 0) as correct
      from jsonb_each(a.state->'rec')
    ) metrics
    where a.role = 'student'
  ) row_view;
  return jsonb_build_object('students', rows);
end;
$$;

revoke all on function pharm.empty_progress(), pharm.membership(jsonb,jsonb) from public, anon, authenticated;
grant execute on function pharm.empty_progress(), pharm.membership(jsonb,jsonb) to service_role;
revoke all on function public.pharm_quiz_student(text,text,jsonb), public.pharm_quiz_admin(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.pharm_quiz_student(text,text,jsonb), public.pharm_quiz_admin(text,text,jsonb) to service_role;
notify pgrst, 'reload schema';
