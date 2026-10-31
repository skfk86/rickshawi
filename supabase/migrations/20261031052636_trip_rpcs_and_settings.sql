create table public.app_settings (
  id int primary key default 1 check (id = 1),
  require_subscription boolean not null default false,
  base_fare int not null default 1000,
  per_km int not null default 350,
  subscription_price int not null default 15000,
  bankak_account text default '[رقم حساب بنكك]',
  bankak_name text default '[اسم صاحب الحساب]'
);
insert into public.app_settings default values;
alter table public.app_settings enable row level security;
create policy "settings read" on public.app_settings for select to authenticated using (true);
create policy "settings admin" on public.app_settings for update to authenticated using (public.is_admin());

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, phone, full_name)
  values (new.id, coalesce(new.phone, new.raw_user_meta_data->>'phone'), new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end; $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create or replace function public.nearby_drivers(lat double precision, lng double precision, radius_m int default 3000, max_results int default 10)
returns table (driver_id uuid, full_name text, avatar_url text, rating_avg numeric, plate_number text, vehicle_color text, lat double precision, lng double precision, distance_m double precision)
language sql stable security definer set search_path = public, extensions as $$
  select d.id, p.full_name, p.avatar_url, p.rating_avg, d.plate_number, d.vehicle_color,
    st_y(d.location::geometry), st_x(d.location::geometry),
    st_distance(d.location, st_makepoint(lng, lat)::geography) as distance_m
  from drivers d join profiles p on p.id = d.id
  where d.is_online and d.status = 'approved'
    and d.location_updated_at > now() - interval '2 minutes'
    and st_dwithin(d.location, st_makepoint(lng, lat)::geography, radius_m)
    and (not (select require_subscription from app_settings where id = 1)
         or exists (select 1 from subscriptions s where s.driver_id = d.id and s.status = 'active' and now() between s.starts_at and s.ends_at))
  order by distance_m
  limit max_results;
$$;
revoke execute on function public.nearby_drivers(double precision, double precision, int, int) from public, anon;

create or replace function public.open_requests(radius_m int default 4000)
returns table (id uuid, rider_name text, rider_rating numeric, pickup_address text, dropoff_address text, distance_km numeric, offered_price int, pickup_lat double precision, pickup_lng double precision, away_m double precision, created_at timestamptz)
language sql stable security definer set search_path = public, extensions as $$
  select t.id, p.full_name, p.rating_avg, t.pickup_address, t.dropoff_address, t.distance_km, t.offered_price,
    st_y(t.pickup::geometry), st_x(t.pickup::geometry), st_distance(t.pickup, d.location), t.created_at
  from trips t join profiles p on p.id = t.rider_id
  join drivers d on d.id = auth.uid() and d.status = 'approved' and d.location is not null
  where t.status = 'requested' and t.created_at > now() - interval '15 minutes'
    and st_dwithin(t.pickup, d.location, radius_m)
    and not exists (select 1 from trip_offers o where o.trip_id = t.id and o.driver_id = auth.uid() and o.status = 'rejected')
  order by t.created_at desc;
$$;

create or replace function public.accept_trip(p_trip uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from drivers where id = auth.uid() and status = 'approved') then raise exception 'not_approved'; end if;
  if exists (select 1 from trips where driver_id = auth.uid() and status in ('accepted','arriving','arrived','in_progress')) then raise exception 'busy'; end if;
  update trips set driver_id = auth.uid(), status = 'accepted', final_price = offered_price, accepted_at = now()
  where id = p_trip and status = 'requested';
  if not found then raise exception 'taken'; end if;
end; $$;

create or replace function public.make_offer(p_trip uuid, p_price int) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from drivers where id = auth.uid() and status = 'approved') then raise exception 'not_approved'; end if;
  insert into trip_offers (trip_id, driver_id, price, status)
  select p_trip, auth.uid(), p_price, 'pending' from trips where id = p_trip and status = 'requested'
  on conflict (trip_id, driver_id) do update set price = excluded.price, status = 'pending', created_at = now();
end; $$;

create or replace function public.accept_offer(p_offer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o trip_offers;
begin
  select * into o from trip_offers where id = p_offer and status = 'pending';
  if not found then raise exception 'no_offer'; end if;
  if exists (select 1 from trips where driver_id = o.driver_id and status in ('accepted','arriving','arrived','in_progress')) then raise exception 'busy'; end if;
  update trips set driver_id = o.driver_id, status = 'accepted', final_price = o.price, accepted_at = now()
  where id = o.trip_id and rider_id = auth.uid() and status = 'requested';
  if not found then raise exception 'taken'; end if;
  update trip_offers set status = case when id = p_offer then 'accepted' else 'rejected' end where trip_id = o.trip_id;
end; $$;

create or replace function public.set_trip_status(p_trip uuid, p_status trip_status, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare t trips;
begin
  select * into t from trips where id = p_trip;
  if not found then raise exception 'no_trip'; end if;
  if p_status = 'cancelled' then
    if auth.uid() is distinct from t.rider_id and auth.uid() is distinct from t.driver_id then raise exception 'forbidden'; end if;
    if t.status in ('completed','cancelled','in_progress') then raise exception 'bad_state'; end if;
    update trips set status = 'cancelled', cancelled_by = auth.uid(), cancel_reason = p_reason where id = p_trip;
    return;
  end if;
  if auth.uid() is distinct from t.driver_id then raise exception 'forbidden'; end if;
  if not ((t.status = 'accepted' and p_status in ('arriving','arrived'))
       or (t.status = 'arriving' and p_status = 'arrived')
       or (t.status = 'arrived' and p_status = 'in_progress')
       or (t.status = 'in_progress' and p_status = 'completed')) then raise exception 'bad_state'; end if;
  update trips set status = p_status, completed_at = case when p_status = 'completed' then now() end where id = p_trip;
end; $$;

create or replace function public.set_online(p_online boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_online and (select require_subscription from app_settings where id = 1)
     and not exists (select 1 from subscriptions s where s.driver_id = auth.uid() and s.status = 'active' and now() between s.starts_at and s.ends_at)
  then raise exception 'no_subscription'; end if;
  update drivers set is_online = p_online where id = auth.uid() and status = 'approved';
  if not found then raise exception 'not_approved'; end if;
end; $$;

create or replace function public.my_earnings(days int default 7)
returns table (day date, total int, trips int)
language sql stable security definer set search_path = public as $$
  select (completed_at at time zone 'Africa/Khartoum')::date, sum(final_price)::int, count(*)::int
  from trips where driver_id = auth.uid() and status = 'completed' and completed_at > now() - make_interval(days => days)
  group by 1 order by 1;
$$;

alter policy "trips party update" on public.trips using (false);
alter policy "drivers update own" on public.drivers
  using (id = auth.uid())
  with check (id = auth.uid()
    and status = (select d.status from public.drivers d where d.id = auth.uid())
    and is_online = (select d.is_online from public.drivers d where d.id = auth.uid()));

do $$ declare f text; begin
  foreach f in array array['open_requests(int)','accept_trip(uuid)','make_offer(uuid,int)','accept_offer(uuid)','set_trip_status(uuid,trip_status,text)','set_online(boolean)','my_earnings(int)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
  end loop;
end $$;
