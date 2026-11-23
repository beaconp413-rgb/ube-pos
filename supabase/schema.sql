-- Ube POS cloud schema: email login, one business (team) per owner, invite by email.
-- Every app record (product, batch, sale, order, ...) is one row in public.records as JSON.

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  owner uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table public.members (
  team_id uuid not null references public.teams on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  email text not null,
  name text,
  role text not null default 'member' check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index members_user_idx on public.members (user_id);

create table public.invites (
  team_id uuid not null references public.teams on delete cascade,
  email text not null check (email = lower(email) and position('@' in email) > 1),
  invited_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  primary key (team_id, email)
);
create index invites_email_idx on public.invites (email);

create table public.records (
  team_id uuid not null references public.teams on delete cascade,
  coll text not null check (coll in ('meta','products','batches','sales','orders','customers','cash','losses','moves','closes')),
  id text not null,
  data jsonb not null,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (team_id, coll, id)
);
create index records_sync_idx on public.records (team_id, updated_at);

-- server sets the sync clock, so phone clocks don't matter
create or replace function public.touch_record() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger records_touch before insert or update on public.records
  for each row execute function public.touch_record();

-- helpers (security definer so policies don't recurse)
create or replace function public.is_member(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where team_id = t and user_id = auth.uid())
$$;
create or replace function public.is_owner(t uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where team_id = t and user_id = auth.uid() and role = 'owner')
$$;

alter table public.teams enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
alter table public.records enable row level security;

create policy teams_read on public.teams for select to authenticated using (public.is_member(id));

create policy members_read on public.members for select to authenticated using (public.is_member(team_id));
create policy members_remove on public.members for delete to authenticated
  using ((public.is_owner(team_id) and role <> 'owner') or (user_id = auth.uid() and role <> 'owner'));

create policy invites_read on public.invites for select to authenticated
  using (public.is_owner(team_id) or email = lower(auth.jwt() ->> 'email'));
create policy invites_add on public.invites for insert to authenticated
  with check (public.is_owner(team_id) and invited_by = auth.uid());
create policy invites_cancel on public.invites for delete to authenticated using (public.is_owner(team_id));

create policy records_read on public.records for select to authenticated using (public.is_member(team_id));
create policy records_add on public.records for insert to authenticated with check (public.is_member(team_id));
create policy records_edit on public.records for update to authenticated
  using (public.is_member(team_id)) with check (public.is_member(team_id));
-- no delete policy: the app soft-deletes (deleted = true) so other phones learn about it

-- create a business; caller becomes owner
create or replace function public.create_team(p_team text, p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare t uuid; e text := lower(auth.jwt() ->> 'email');
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'already in a team'; end if;
  insert into public.teams (name, owner) values (p_team, auth.uid()) returning id into t;
  insert into public.members (team_id, user_id, email, name, role) values (t, auth.uid(), e, nullif(p_name, ''), 'owner');
  return t;
end $$;

-- join every team that invited my email
create or replace function public.accept_invites(p_name text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare e text := lower(auth.jwt() ->> 'email'); t uuid;
begin
  if auth.uid() is null or e is null then return null; end if;
  insert into public.members (team_id, user_id, email, name, role)
    select i.team_id, auth.uid(), e, nullif(p_name, ''), 'member' from public.invites i where i.email = e
    on conflict do nothing;
  delete from public.invites where email = e;
  select team_id into t from public.members where user_id = auth.uid() order by joined_at limit 1;
  return t;
end $$;

create or replace function public.set_my_name(p_team uuid, p_name text) returns void
language sql security definer set search_path = '' as $$
  update public.members set name = nullif(left(p_name, 40), '') where team_id = p_team and user_id = auth.uid()
$$;

revoke execute on function public.create_team(text, text), public.accept_invites(text), public.set_my_name(uuid, text),
  public.is_member(uuid), public.is_owner(uuid) from public, anon;
grant execute on function public.create_team(text, text), public.accept_invites(text), public.set_my_name(uuid, text),
  public.is_member(uuid), public.is_owner(uuid) to authenticated;

-- live updates between phones
alter publication supabase_realtime add table public.records;
