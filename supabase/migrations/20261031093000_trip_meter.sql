alter table public.trips add column if not exists traveled_km numeric(7,3) not null default 0;
alter table public.trips add column if not exists started_at timestamptz;

create or replace function public.update_trip_meter(p_trip uuid, p_km numeric) returns void
language sql security definer set search_path = public as $$
  update trips set traveled_km = greatest(traveled_km, least(p_km, 500))
  where id = p_trip and driver_id = auth.uid() and status = 'in_progress';
$$;
revoke execute on function public.update_trip_meter(uuid, numeric) from public, anon;
-- set_trip_status: يسجّل started_at عند بداية المشوار (انظر قاعدة البيانات للنسخة الكاملة)
