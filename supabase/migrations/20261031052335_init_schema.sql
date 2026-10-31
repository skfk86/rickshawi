create extension if not exists postgis with schema extensions;

create type public.user_role as enum ('rider','driver','admin');
create type public.driver_status as enum ('pending','approved','rejected','suspended');
create type public.trip_status as enum ('requested','accepted','arriving','arrived','in_progress','completed','cancelled');
create type public.doc_type as enum ('photo','license','vehicle_registration','vehicle_photo');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text unique,
  avatar_url text,
  role public.user_role not null default 'rider',
  rating_avg numeric(2,1) default 5.0,
  rating_count int default 0,
  created_at timestamptz default now()
);

create table public.drivers (
  id uuid primary key references public.profiles(id) on delete cascade,
  status public.driver_status not null default 'pending',
  plate_number text,
  vehicle_color text,
  is_online boolean not null default false,
  location extensions.geography(Point,4326),
  location_updated_at timestamptz,
  bankak_account text,
  created_at timestamptz default now()
);
create index drivers_location_idx on public.drivers using gist (location);

create table public.driver_documents (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id) on delete cascade,
  type public.doc_type not null,
  file_path text not null,
  verified boolean default false,
  created_at timestamptz default now(),
  unique (driver_id, type)
);

create table public.trips (
  id uuid primary key default gen_random_uuid(),
  rider_id uuid not null references public.profiles(id),
  driver_id uuid references public.drivers(id),
  status public.trip_status not null default 'requested',
  pickup extensions.geography(Point,4326) not null,
  pickup_address text,
  dropoff extensions.geography(Point,4326) not null,
  dropoff_address text,
  distance_km numeric(6,2),
  offered_price int not null,
  final_price int,
  payment_method text not null default 'cash',
  cancelled_by uuid,
  cancel_reason text,
  created_at timestamptz default now(),
  accepted_at timestamptz,
  completed_at timestamptz
);
create index trips_rider_idx on public.trips(rider_id, created_at desc);
create index trips_driver_idx on public.trips(driver_id, created_at desc);
create index trips_status_idx on public.trips(status) where status = 'requested';

create table public.trip_offers (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  driver_id uuid not null references public.drivers(id),
  price int not null,
  eta_minutes int,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','expired')),
  created_at timestamptz default now(),
  unique (trip_id, driver_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  body text,
  location extensions.geography(Point,4326),
  read_at timestamptz,
  created_at timestamptz default now(),
  check (body is not null or location is not null)
);
create index messages_trip_idx on public.messages(trip_id, created_at);

create table public.ratings (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  rater_id uuid not null references public.profiles(id),
  ratee_id uuid not null references public.profiles(id),
  stars int not null check (stars between 1 and 5),
  tags text[] default '{}',
  note text,
  created_at timestamptz default now(),
  unique (trip_id, rater_id)
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id) on delete cascade,
  amount int not null,
  bankak_ref text,
  receipt_path text,
  status text not null default 'pending' check (status in ('pending','active','rejected','expired')),
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz default now()
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.is_trip_party(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from trips where id = t and (rider_id = auth.uid() or driver_id = auth.uid()));
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, phone, full_name)
  values (new.id, new.phone, new.raw_user_meta_data->>'full_name');
  return new;
end; $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.update_rating_avg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update profiles p set
    rating_avg = s.avg, rating_count = s.cnt
  from (select round(avg(stars)::numeric,1) avg, count(*) cnt from ratings where ratee_id = new.ratee_id) s
  where p.id = new.ratee_id;
  return new;
end; $$;
create trigger on_rating_insert after insert on public.ratings
  for each row execute function public.update_rating_avg();

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
    and exists (select 1 from subscriptions s where s.driver_id = d.id and s.status = 'active' and now() between s.starts_at and s.ends_at)
  order by distance_m
  limit max_results;
$$;

create or replace function public.update_my_location(lat double precision, lng double precision)
returns void language sql security definer set search_path = public, extensions as $$
  update drivers set location = st_makepoint(lng, lat)::geography, location_updated_at = now()
  where id = auth.uid();
$$;

alter table public.profiles enable row level security;
alter table public.drivers enable row level security;
alter table public.driver_documents enable row level security;
alter table public.trips enable row level security;
alter table public.trip_offers enable row level security;
alter table public.messages enable row level security;
alter table public.ratings enable row level security;
alter table public.subscriptions enable row level security;

create policy "profiles read" on public.profiles for select to authenticated using (true);
create policy "profiles update own" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and role = (select role from public.profiles where id = auth.uid()));

create policy "drivers read approved or own" on public.drivers for select to authenticated
  using (status = 'approved' or id = auth.uid() or public.is_admin());
create policy "drivers insert own" on public.drivers for insert to authenticated
  with check (id = auth.uid() and status = 'pending');
create policy "drivers update own" on public.drivers for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid() and status = (select status from public.drivers where id = auth.uid()));
create policy "drivers admin" on public.drivers for update to authenticated using (public.is_admin());

create policy "docs own" on public.driver_documents for all to authenticated
  using (driver_id = auth.uid() or public.is_admin()) with check (driver_id = auth.uid());

create policy "trips party read" on public.trips for select to authenticated
  using (rider_id = auth.uid() or driver_id = auth.uid() or public.is_admin()
         or (status = 'requested' and exists (select 1 from public.drivers d where d.id = auth.uid() and d.status = 'approved')));
create policy "trips rider insert" on public.trips for insert to authenticated
  with check (rider_id = auth.uid() and status = 'requested' and driver_id is null);
create policy "trips party update" on public.trips for update to authenticated
  using (rider_id = auth.uid() or driver_id = auth.uid());

create policy "offers read" on public.trip_offers for select to authenticated
  using (driver_id = auth.uid() or exists (select 1 from public.trips t where t.id = trip_id and t.rider_id = auth.uid()));
create policy "offers driver insert" on public.trip_offers for insert to authenticated
  with check (driver_id = auth.uid() and exists (select 1 from public.trips t where t.id = trip_id and t.status = 'requested'));

create policy "messages party read" on public.messages for select to authenticated using (public.is_trip_party(trip_id));
create policy "messages party send" on public.messages for insert to authenticated
  with check (sender_id = auth.uid() and public.is_trip_party(trip_id));
create policy "messages mark read" on public.messages for update to authenticated
  using (public.is_trip_party(trip_id) and sender_id <> auth.uid());

create policy "ratings read" on public.ratings for select to authenticated using (true);
create policy "ratings insert" on public.ratings for insert to authenticated
  with check (rater_id = auth.uid() and exists (select 1 from public.trips t where t.id = trip_id and t.status = 'completed'
    and ((t.rider_id = auth.uid() and t.driver_id = ratee_id) or (t.driver_id = auth.uid() and t.rider_id = ratee_id))));

create policy "subs own" on public.subscriptions for select to authenticated using (driver_id = auth.uid() or public.is_admin());
create policy "subs request" on public.subscriptions for insert to authenticated with check (driver_id = auth.uid() and status = 'pending');
create policy "subs admin" on public.subscriptions for update to authenticated using (public.is_admin());

alter publication supabase_realtime add table public.trips, public.trip_offers, public.messages, public.drivers;

insert into storage.buckets (id, name, public) values ('driver-docs','driver-docs', false), ('avatars','avatars', true), ('receipts','receipts', false)
on conflict do nothing;
create policy "own folder upload" on storage.objects for insert to authenticated
  with check (bucket_id in ('driver-docs','avatars','receipts') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own folder read" on storage.objects for select to authenticated
  using ((bucket_id in ('driver-docs','receipts') and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())) or bucket_id = 'avatars');
