-- الطرحة: مشاركة الركشة بين ٣–٤ ركاب وتقسيم المبلغ
alter table public.trips add column if not exists is_shared boolean not null default false;
alter table public.trips add column if not exists capacity int not null default 4 check (capacity between 1 and 6);
alter table public.app_settings add column if not exists shared_extra_pct int not null default 25;
alter table public.app_settings add column if not exists shared_capacity int not null default 4;

create table public.trip_passengers (
  trip_id uuid not null references public.trips(id) on delete cascade,
  rider_id uuid not null references public.profiles(id),
  seats int not null default 1 check (seats between 1 and 4),
  pickup extensions.geography(Point,4326) not null,
  pickup_address text,
  dropoff extensions.geography(Point,4326) not null,
  dropoff_address text,
  status text not null default 'joined' check (status in ('joined','left')),
  is_owner boolean not null default false,
  joined_at timestamptz default now(),
  primary key (trip_id, rider_id)
);
create index trip_passengers_rider_idx on public.trip_passengers(rider_id, joined_at desc);
alter table public.trip_passengers enable row level security;

create or replace function public.is_trip_party(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from trips where id = t and (rider_id = auth.uid() or driver_id = auth.uid()))
      or exists (select 1 from trip_passengers p where p.trip_id = t and p.rider_id = auth.uid() and p.status = 'joined');
$$;
revoke execute on function public.is_trip_party(uuid) from public, anon;

create policy "passengers read" on public.trip_passengers for select to authenticated
  using ((select public.is_trip_party(trip_id)) or (select public.is_admin()));

alter policy "trips party read" on public.trips
  using (rider_id = (select auth.uid()) or driver_id = (select auth.uid()) or (select public.is_admin())
         or public.is_trip_party(id)
         or (status = 'requested' and exists (select 1 from public.drivers d where d.id = (select auth.uid()) and d.status = 'approved')));

alter policy "ratings insert" on public.ratings
  with check (rater_id = (select auth.uid()) and exists (select 1 from public.trips t where t.id = trip_id and t.status = 'completed'
    and ((t.driver_id = ratee_id and (t.rider_id = (select auth.uid()) or exists (select 1 from public.trip_passengers p where p.trip_id = t.id and p.rider_id = (select auth.uid()) and p.status = 'joined')))
      or (t.driver_id = (select auth.uid()) and (t.rider_id = ratee_id or exists (select 1 from public.trip_passengers p where p.trip_id = t.id and p.rider_id = ratee_id and p.status = 'joined'))))));

create or replace function public.trip_shares(p_trip uuid)
returns table (rider_id uuid, full_name text, phone text, seats int, is_owner boolean, share int, total int,
  pickup_lat double precision, pickup_lng double precision, pickup_address text, dropoff_lat double precision, dropoff_lng double precision, dropoff_address text)
language sql stable security definer set search_path = public, extensions as $$
  with t as (select * from trips where id = p_trip and (public.is_trip_party(p_trip) or public.is_admin())),
  ps as (select p.* from trip_passengers p join t on t.id = p.trip_id where p.status = 'joined'),
  agg as (select count(*) groups, coalesce(sum(seats),0) seats from ps),
  tot as (select round(coalesce(t.final_price, t.offered_price) * (1 + (select shared_extra_pct from app_settings where id=1) / 100.0 * greatest(agg.groups - 1, 0)) / 100) * 100 total, agg.seats from t, agg)
  select ps.rider_id, pr.full_name, pr.phone, ps.seats, ps.is_owner,
    (round(tot.total * ps.seats / nullif(tot.seats,0) / 100) * 100)::int, tot.total::int,
    st_y(ps.pickup::geometry), st_x(ps.pickup::geometry), ps.pickup_address,
    st_y(ps.dropoff::geometry), st_x(ps.dropoff::geometry), ps.dropoff_address
  from ps join profiles pr on pr.id = ps.rider_id, tot
  order by ps.is_owner desc, ps.joined_at;
$$;

create or replace function public.make_trip_shared(p_trip uuid, p_seats int) returns void
language plpgsql security definer set search_path = public as $$
declare t trips; cap int;
begin
  select * into t from trips where id = p_trip and rider_id = auth.uid() and status = 'requested';
  if not found then raise exception 'forbidden'; end if;
  select shared_capacity into cap from app_settings where id = 1;
  if p_seats < 1 or p_seats >= cap then raise exception 'bad_seats'; end if;
  update trips set is_shared = true, capacity = cap where id = p_trip;
  insert into trip_passengers (trip_id, rider_id, seats, pickup, pickup_address, dropoff, dropoff_address, is_owner)
  values (p_trip, auth.uid(), p_seats, t.pickup, t.pickup_address, t.dropoff, t.dropoff_address, true)
  on conflict (trip_id, rider_id) do update set seats = excluded.seats, status = 'joined';
end; $$;

create or replace function public.open_shared_trips(plat double precision, plng double precision, dlat double precision, dlng double precision)
returns table (id uuid, status trip_status, pickup_address text, dropoff_address text, price int, seats_left int, groups int,
  pickup_away_m double precision, dropoff_away_m double precision, driver_name text, created_at timestamptz)
language sql stable security definer set search_path = public, extensions as $$
  select t.id, t.status, t.pickup_address, t.dropoff_address, coalesce(t.final_price, t.offered_price),
    (t.capacity - coalesce((select sum(seats) from trip_passengers p where p.trip_id = t.id and p.status='joined'),0))::int,
    (select count(*) from trip_passengers p where p.trip_id = t.id and p.status='joined')::int,
    st_distance(t.pickup, st_makepoint(plng, plat)::geography), st_distance(t.dropoff, st_makepoint(dlng, dlat)::geography),
    (select full_name from profiles where id = t.driver_id), t.created_at
  from trips t
  where t.is_shared and t.status in ('requested','accepted','arriving') and t.created_at > now() - interval '25 minutes'
    and st_dwithin(t.pickup, st_makepoint(plng, plat)::geography, 700)
    and st_dwithin(t.dropoff, st_makepoint(dlng, dlat)::geography, 1500)
    and not exists (select 1 from trip_passengers p where p.trip_id = t.id and p.rider_id = auth.uid())
    and t.rider_id <> auth.uid()
    and t.capacity - coalesce((select sum(seats) from trip_passengers p where p.trip_id = t.id and p.status='joined'),0) > 0
  order by 8 limit 5;
$$;

create or replace function public.join_shared_trip(p_trip uuid, p_seats int, plat double precision, plng double precision, paddr text, dlat double precision, dlng double precision, daddr text)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare t trips; used int;
begin
  select * into t from trips where id = p_trip for update;
  if not found or not t.is_shared or t.status not in ('requested','accepted','arriving') then raise exception 'not_joinable'; end if;
  if t.rider_id = auth.uid() then raise exception 'not_joinable'; end if;
  if exists (select 1 from trips x where x.rider_id = auth.uid() and x.status in ('requested','accepted','arriving','arrived','in_progress'))
     or exists (select 1 from trip_passengers p join trips x on x.id = p.trip_id where p.rider_id = auth.uid() and p.status='joined' and x.id <> p_trip and x.status in ('requested','accepted','arriving','arrived','in_progress'))
  then raise exception 'busy'; end if;
  select coalesce(sum(seats),0) into used from trip_passengers where trip_id = p_trip and status='joined' and rider_id <> auth.uid();
  if used + p_seats > t.capacity then raise exception 'full'; end if;
  insert into trip_passengers (trip_id, rider_id, seats, pickup, pickup_address, dropoff, dropoff_address)
  values (p_trip, auth.uid(), p_seats, st_makepoint(plng, plat)::geography, paddr, st_makepoint(dlng, dlat)::geography, daddr)
  on conflict (trip_id, rider_id) do update set seats = excluded.seats, status = 'joined', pickup = excluded.pickup, pickup_address = excluded.pickup_address,
    dropoff = excluded.dropoff, dropoff_address = excluded.dropoff_address, joined_at = now();
end; $$;

create or replace function public.leave_shared_trip(p_trip uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t trips;
begin
  select * into t from trips where id = p_trip;
  if not found or t.status in ('in_progress','completed','cancelled') then raise exception 'bad_state'; end if;
  update trip_passengers set status = 'left' where trip_id = p_trip and rider_id = auth.uid() and not is_owner;
  if not found then raise exception 'forbidden'; end if;
end; $$;

create or replace function public.open_requests_v2(radius_m int default 4000)
returns table (id uuid, rider_name text, rider_rating numeric, pickup_address text, dropoff_address text, distance_km numeric, offered_price int, pickup_lat double precision, pickup_lng double precision, away_m double precision, created_at timestamptz, is_shared boolean, riders int)
language sql stable security definer set search_path = public, extensions as $$
  select t.id, p.full_name, p.rating_avg, t.pickup_address, t.dropoff_address, t.distance_km, t.offered_price,
    st_y(t.pickup::geometry), st_x(t.pickup::geometry), st_distance(t.pickup, d.location), t.created_at,
    t.is_shared, coalesce((select sum(seats) from trip_passengers x where x.trip_id = t.id and x.status='joined'),1)::int
  from trips t join profiles p on p.id = t.rider_id
  join drivers d on d.id = auth.uid() and d.status = 'approved' and d.location is not null
  where t.status = 'requested' and t.created_at > now() - interval '15 minutes'
    and st_dwithin(t.pickup, d.location, radius_m)
    and not exists (select 1 from trip_offers o where o.trip_id = t.id and o.driver_id = auth.uid() and o.status = 'rejected')
  order by t.created_at desc;
$$;

do $$ declare f text; begin
  foreach f in array array['trip_shares(uuid)','make_trip_shared(uuid,int)','open_shared_trips(double precision,double precision,double precision,double precision)','join_shared_trip(uuid,int,double precision,double precision,text,double precision,double precision,text)','leave_shared_trip(uuid)','open_requests_v2(int)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
  end loop;
end $$;

alter publication supabase_realtime add table public.trip_passengers;
