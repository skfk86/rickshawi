revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.update_rating_avg() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.is_trip_party(uuid) from public, anon;
revoke execute on function public.nearby_drivers(double precision, double precision, int, int) from public, anon;
revoke execute on function public.update_my_location(double precision, double precision) from public, anon;
