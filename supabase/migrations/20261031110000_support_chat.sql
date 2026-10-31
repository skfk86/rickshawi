create table public.support_threads (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  status text not null default 'open' check (status in ('open','closed')),
  last_message text,
  last_at timestamptz default now(),
  unread_admin int not null default 0,
  unread_user int not null default 0,
  created_at timestamptz default now()
);
create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.support_threads(user_id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  from_admin boolean not null default false,
  body text,
  image_path text,
  created_at timestamptz default now(),
  check (body is not null or image_path is not null)
);
create index support_messages_thread_idx on public.support_messages(thread_id, created_at);

alter table public.support_threads enable row level security;
alter table public.support_messages enable row level security;

create policy "threads own or admin" on public.support_threads for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
create policy "threads create own" on public.support_threads for insert to authenticated
  with check (user_id = auth.uid());

create policy "smsg read" on public.support_messages for select to authenticated
  using (thread_id = auth.uid() or public.is_admin());
create policy "smsg send" on public.support_messages for insert to authenticated
  with check (sender_id = auth.uid()
    and ((thread_id = auth.uid() and from_admin = false) or (public.is_admin() and from_admin = true)));

create or replace function public.on_support_message() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update support_threads set
    last_message = coalesce(new.body, '📷 صورة'), last_at = new.created_at, status = 'open',
    unread_admin = case when new.from_admin then unread_admin else unread_admin + 1 end,
    unread_user = case when new.from_admin then unread_user + 1 else unread_user end
  where user_id = new.thread_id;
  return new;
end; $$;
revoke execute on function public.on_support_message() from public, anon, authenticated;
create trigger support_message_after after insert on public.support_messages
  for each row execute function public.on_support_message();

create or replace function public.support_mark_read(p_thread uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then update support_threads set unread_admin = 0 where user_id = p_thread;
  elsif p_thread = auth.uid() then update support_threads set unread_user = 0 where user_id = p_thread;
  end if;
end; $$;
create or replace function public.support_set_status(p_thread uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update support_threads set status = p_status where user_id = p_thread;
end; $$;
revoke execute on function public.support_mark_read(uuid) from public, anon;
revoke execute on function public.support_set_status(uuid, text) from public, anon;

alter publication supabase_realtime add table public.support_threads, public.support_messages;

insert into storage.buckets (id, name, public) values ('support','support', false) on conflict do nothing;
create policy "support upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'support' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
create policy "support read" on storage.objects for select to authenticated
  using (bucket_id = 'support' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
