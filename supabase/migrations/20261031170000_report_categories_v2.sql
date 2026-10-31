alter table public.reports drop constraint if exists reports_category_check,
  add constraint reports_category_check check (category in (
    'safety','harassment','price','behavior','route','vehicle','no_show','other',
    'dangerous_driving','overcharge','wrong_vehicle','lost_item','driver_late',
    'no_payment','underpaid','damage','extra_riders','fake_request','rider_no_show'));
alter table public.reports add column if not exists reporter_role text check (reporter_role in ('rider','driver'));
grant insert (reporter_role) on public.reports to authenticated;
