-- ركاب الطرحة يقدروا يبلّغوا عن السواق، والسواق عن أي راكب في المشوار
alter policy "reports create" on public.reports
  with check (reporter_id = (select auth.uid()) and status = 'new' and (
    trip_id is null and reported_id is null
    or exists (select 1 from public.trips t where t.id = trip_id and (
      (t.driver_id = reported_id and (t.rider_id = (select auth.uid())
        or exists (select 1 from public.trip_passengers p where p.trip_id = t.id and p.rider_id = (select auth.uid()) and p.status = 'joined')))
      or (t.driver_id = (select auth.uid()) and (t.rider_id = reported_id
        or exists (select 1 from public.trip_passengers p where p.trip_id = t.id and p.rider_id = reported_id and p.status = 'joined')))))));

-- دخل السواق يحسب إجمالي الطرحة
create or replace function public.trip_total(t trips) returns int
language sql stable security definer set search_path = public as $$
  select case when not t.is_shared then t.final_price else
    (round(t.final_price * (1 + (select shared_extra_pct from app_settings where id=1) / 100.0
      * greatest((select count(*) from trip_passengers p where p.trip_id = t.id and p.status='joined') - 1, 0)) / 100) * 100)::int end;
$$;
revoke execute on function public.trip_total(trips) from public, anon;
create or replace function public.my_earnings(days int default 7)
returns table (day date, total int, trips int)
language sql stable security definer set search_path = public as $$
  select (completed_at at time zone 'Africa/Khartoum')::date, sum(public.trip_total(t))::int, count(*)::int
  from trips t where driver_id = auth.uid() and status = 'completed' and completed_at > now() - make_interval(days => days)
  group by 1 order by 1;
$$;
