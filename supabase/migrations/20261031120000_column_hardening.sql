revoke update on public.profiles from authenticated, anon;
grant update (full_name, avatar_url) on public.profiles to authenticated;
revoke update on public.messages from authenticated, anon;
grant update (read_at) on public.messages to authenticated;
revoke insert on public.trips from authenticated, anon;
grant insert (rider_id, pickup, pickup_address, dropoff, dropoff_address, distance_km, offered_price, payment_method) on public.trips to authenticated;
revoke insert on public.support_threads from authenticated, anon;
grant insert (user_id) on public.support_threads to authenticated;

create index if not exists messages_sender_idx on public.messages(sender_id);
create index if not exists ratings_ratee_idx on public.ratings(ratee_id);
create index if not exists ratings_rater_idx on public.ratings(rater_id);
create index if not exists subscriptions_driver_idx on public.subscriptions(driver_id, created_at desc);
create index if not exists support_messages_sender_idx on public.support_messages(sender_id);
create index if not exists trip_offers_driver_idx on public.trip_offers(driver_id);
