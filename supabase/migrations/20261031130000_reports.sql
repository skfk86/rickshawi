create table public.reports (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references public.trips(id) on delete set null,
  reporter_id uuid not null references public.profiles(id),
  reported_id uuid references public.profiles(id),
  category text not null check (category in ('safety','harassment','price','behavior','route','vehicle','no_show','other')),
  details text,
  image_path text,
  status text not null default 'new' check (status in ('new','reviewing','resolved','dismissed')),
  admin_note text,
  created_at timestamptz default now(),
  resolved_at timestamptz
);
create index reports_status_idx on public.reports(status, created_at desc);
create index reports_reported_idx on public.reports(reported_id);
create index reports_reporter_idx on public.reports(reporter_id);
create index reports_trip_idx on public.reports(trip_id);
alter table public.reports enable row level security;
create policy "reports read own or admin" on public.reports for select to authenticated
  using (reporter_id = (select auth.uid()) or (select public.is_admin()));
create policy "reports create" on public.reports for insert to authenticated
  with check (reporter_id = (select auth.uid()) and status = 'new' and (
    trip_id is null and reported_id is null
    or exists (select 1 from public.trips t where t.id = trip_id and (
      (t.rider_id = (select auth.uid()) and t.driver_id = reported_id) or
      (t.driver_id = (select auth.uid()) and t.rider_id = reported_id)))));
create policy "reports admin update" on public.reports for update to authenticated using ((select public.is_admin()));
revoke insert on public.reports from authenticated, anon;
grant insert (trip_id, reporter_id, reported_id, category, details, image_path) on public.reports to authenticated;
create or replace function public.report_counts(p_users uuid[])
returns table (user_id uuid, total int, open int)
language sql stable security definer set search_path = public as $$
  select reported_id, count(*)::int, count(*) filter (where status in ('new','reviewing'))::int
  from reports where reported_id = any(p_users) and public.is_admin() group by reported_id;
$$;
revoke execute on function public.report_counts(uuid[]) from public, anon;
alter publication supabase_realtime add table public.reports;
insert into storage.buckets (id, name, public) values ('reports','reports', false) on conflict do nothing;
create policy "reports upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'reports' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "reports read" on storage.objects for select to authenticated
  using (bucket_id = 'reports' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
