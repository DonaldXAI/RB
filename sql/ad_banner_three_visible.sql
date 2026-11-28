-- Run once in Supabase SQL Editor: 3 visible homepage ads + 3 queued ($100 / 24h).
-- Replaces single-active index and updates reserve/confirm RPCs.

alter table public.ad_banner_bookings add column if not exists price_usdc numeric not null default 100;

drop index if exists public.ad_banner_one_active_uidx;

create or replace function public.reserve_ad_banner_slot(p_user_id uuid) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  booking_id uuid;
  pipeline integer;
begin
  perform pg_advisory_xact_lock(8142001);

  select count(*) into pipeline
  from public.ad_banner_bookings
  where status in ('active', 'queued');

  if pipeline >= 6 then
    raise exception 'AD_SLOTS_FULL';
  end if;

  if exists (
    select 1 from public.ad_banner_bookings
    where status = 'reserved'
      and expires_at is not null
      and expires_at > now()
      and user_id <> p_user_id
  ) then
    raise exception 'RESERVATION_IN_USE';
  end if;

  if exists (
    select 1 from public.ad_banner_bookings
    where user_id = p_user_id
      and status = 'reserved'
      and expires_at is not null
      and expires_at > now()
  ) then
    select id into booking_id
    from public.ad_banner_bookings
    where user_id = p_user_id
      and status = 'reserved'
      and expires_at > now()
    order by created_at desc
    limit 1;
    return booking_id;
  end if;

  insert into public.ad_banner_bookings (
    user_id, status, expires_at, starts_at, ends_at, price_usdc
  ) values (
    p_user_id,
    'reserved',
    now() + interval '15 minutes',
    now(),
    now() + interval '15 minutes',
    100
  ) returning id into booking_id;

  return booking_id;
end;
$$;

create or replace function public.confirm_ad_banner_booking(
  p_reservation_id uuid,
  p_user_id uuid,
  p_headline text,
  p_image_url text,
  p_target_url text,
  p_tx_signature text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  booking public.ad_banner_bookings%rowtype;
  active_count integer;
  queue_count integer;
  latest timestamptz;
begin
  perform pg_advisory_xact_lock(8142001);

  select * into booking
  from public.ad_banner_bookings
  where id = p_reservation_id
    and user_id = p_user_id
    and status = 'reserved'
  for update;

  if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;
  if booking.expires_at is null or booking.expires_at <= now() then raise exception 'RESERVATION_EXPIRED'; end if;

  insert into public.used_transactions (signature, purpose) values (p_tx_signature, 'ad');

  select count(*) into active_count from public.ad_banner_bookings where status = 'active';
  select count(*) into queue_count from public.ad_banner_bookings where status = 'queued';

  if active_count < 3 then
    update public.ad_banner_bookings
    set headline = p_headline,
        image_url = p_image_url,
        target_url = p_target_url,
        tx_signature = p_tx_signature,
        status = 'active',
        expires_at = null,
        price_usdc = 100,
        starts_at = now(),
        ends_at = now() + interval '24 hours'
    where id = booking.id;
  elsif queue_count < 3 then
    select max(ends_at) into latest
    from public.ad_banner_bookings
    where status in ('active', 'queued');

    update public.ad_banner_bookings
    set headline = p_headline,
        image_url = p_image_url,
        target_url = p_target_url,
        tx_signature = p_tx_signature,
        status = 'queued',
        expires_at = null,
        price_usdc = 100,
        starts_at = coalesce(latest, now()),
        ends_at = coalesce(latest, now()) + interval '24 hours'
    where id = booking.id;
  else
    raise exception 'AD_SLOTS_FULL';
  end if;

  return booking.id;
end;
$$;

revoke all on function public.reserve_ad_banner_slot(uuid) from public;
revoke all on function public.confirm_ad_banner_booking(uuid, uuid, text, text, text, text) from public;
grant execute on function public.reserve_ad_banner_slot(uuid) to service_role;
grant execute on function public.confirm_ad_banner_booking(uuid, uuid, text, text, text, text) to service_role;