-- السواقين المفضلين + الطلب الموجّه (٩٠ ثانية للسواق المفضل قبل ما يتفتح للكل)
create table public.favorite_drivers (
  rider_id uuid not null references public.profiles(id) on delete cascade,
  driver_id uuid not null references public.drivers(id) on delete cascade,
  nickname text not null check (char_length(nickname) between 1 and 40),
  category text not null default 'trusted' check (category in ('trusted','family','neighbor','daily','other')),
  note text check (char_length(note) <= 120),
  created_at timestamptz default now(),
  primary key (rider_id, driver_id)
);
create index favorite_drivers_driver_idx on public.favorite_drivers(driver_id);
alter table public.favorite_drivers enable row level security;
create policy "fav own read" on public.favorite_drivers for select to authenticated using (rider_id = (select auth.uid()));
create policy "fav own insert" on public.favorite_drivers for insert to authenticated with check (rider_id = (select auth.uid()));
create policy "fav own update" on public.favorite_drivers for update to authenticated using (rider_id = (select auth.uid())) with check (rider_id = (select auth.uid()));
create policy "fav own delete" on public.favorite_drivers for delete to authenticated using (rider_id = (select auth.uid()));

alter table public.trips add column if not exists preferred_driver_id uuid references public.drivers(id);
alter table public.trips add column if not exists preferred_until timestamptz;
grant insert (preferred_driver_id) on public.trips to authenticated;

create or replace function public.set_preferred_window() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.preferred_driver_id is not null then new.preferred_until := now() + interval '90 seconds';
  else new.preferred_until := null; end if;
  return new;
end; $$;
revoke execute on function public.set_preferred_window() from public, anon, authenticated;
create trigger trips_preferred_window before insert on public.trips for each row execute function public.set_preferred_window();

create or replace function public.open_requests_v3(radius_m int default 4000)
returns table (id uuid, rider_name text, rider_rating numeric, pickup_address text, dropoff_address text, distance_km numeric, offered_price int,
  pickup_lat double precision, pickup_lng double precision, away_m double precision, created_at timestamptz, is_shared boolean, riders int, is_preferred boolean)
language sql stable security definer set search_path = public, extensions as $$
  select t.id, p.full_name, p.rating_avg, t.pickup_address, t.dropoff_address, t.distance_km, t.offered_price,
    st_y(t.pickup::geometry), st_x(t.pickup::geometry), st_distance(t.pickup, d.location), t.created_at,
    t.is_shared, coalesce((select sum(seats) from trip_passengers x where x.trip_id = t.id and x.status='joined'),1)::int,
    t.preferred_driver_id = auth.uid()
  from trips t join profiles p on p.id = t.rider_id
  join drivers d on d.id = auth.uid() and d.status = 'approved' and d.location is not null
  where t.status = 'requested' and t.created_at > now() - interval '15 minutes'
    and (t.preferred_driver_id = auth.uid()
         or (st_dwithin(t.pickup, d.location, radius_m)
             and (t.preferred_driver_id is null or t.preferred_until < now())))
    and not exists (select 1 from trip_offers o where o.trip_id = t.id and o.driver_id = auth.uid() and o.status = 'rejected')
  order by (t.preferred_driver_id = auth.uid()) desc nulls last, t.created_at desc;
$$;
revoke execute on function public.open_requests_v3(int) from public, anon;

create or replace function public.my_favorite_drivers(lat double precision default null, lng double precision default null)
returns table (driver_id uuid, nickname text, category text, note text, full_name text, phone text, avatar_url text, rating_avg numeric, rating_count int,
  plate_number text, vehicle_color text, is_available boolean, distance_m double precision, trips_together int, created_at timestamptz)
language sql stable security definer set search_path = public, extensions as $$
  select f.driver_id, f.nickname, f.category, f.note, p.full_name, p.phone, p.avatar_url, p.rating_avg, p.rating_count,
    d.plate_number, d.vehicle_color,
    (d.status = 'approved' and d.is_online and d.location_updated_at > now() - interval '2 minutes'
      and not exists (select 1 from trips x where x.driver_id = d.id and x.status in ('accepted','arriving','arrived','in_progress'))),
    case when lat is null or d.location is null then null else st_distance(d.location, st_makepoint(lng, lat)::geography) end,
    (select count(*) from trips x where x.driver_id = d.id and x.status = 'completed'
       and (x.rider_id = auth.uid() or exists (select 1 from trip_passengers tp where tp.trip_id = x.id and tp.rider_id = auth.uid())))::int,
    f.created_at
  from favorite_drivers f join drivers d on d.id = f.driver_id join profiles p on p.id = f.driver_id
  where f.rider_id = auth.uid() and d.status = 'approved'
  order by 12 desc, f.created_at desc;
$$;
revoke execute on function public.my_favorite_drivers(double precision, double precision) from public, anon;
