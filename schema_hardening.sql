-- Run after the base schema.sql on existing databases.

alter table public.profiles add column if not exists last_ip text;

alter table public.campaigns add column if not exists bundle_boost_fee_usdc numeric not null default 0 check (bundle_boost_fee_usdc >= 0);

create table if not exists public.admin_nonces (
  nonce text primary key,
  admin_wallet text not null,
  message_timestamp timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists admin_nonces_created_idx on public.admin_nonces (created_at);

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  admin_wallet text not null,
  action text not null,
  target_type text not null,
  target_id text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.ad_banner_bookings add column if not exists expires_at timestamptz;
alter table public.ad_banner_bookings alter column tx_signature drop not null;
alter table public.ad_banner_bookings alter column headline drop not null;
alter table public.ad_banner_bookings alter column image_url drop not null;
alter table public.ad_banner_bookings alter column target_url drop not null;

alter table public.ad_banner_bookings drop constraint if exists ad_banner_bookings_status_check;
alter table public.ad_banner_bookings add constraint ad_banner_bookings_status_check
  check (status in ('active', 'queued', 'completed', 'refunded', 'reserved', 'expired'));

alter table public.ad_banner_bookings enable row level security;

create or replace function public.activate_campaign_deposit(
  p_campaign_id uuid,
  p_founder_id uuid,
  p_tx text,
  p_sender_wallet text,
  p_referral_rate numeric,
  p_platform_fee numeric,
  p_boost_fee numeric,
  p_founder_ip text
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  camp public.campaigns%rowtype;
  referrer uuid;
  ref_profile public.profiles%rowtype;
  founder_profile public.profiles%rowtype;
  bonus numeric := 0;
  computed_platform numeric;
  computed_boost numeric;
begin
  select * into camp from public.campaigns where id = p_campaign_id for update;
  if not found then raise exception 'NOT_AWAITING_DEPOSIT'; end if;
  if camp.founder_id <> p_founder_id then raise exception 'NOT_OWNER'; end if;
  if camp.status <> 'awaiting_deposit' then raise exception 'NOT_AWAITING_DEPOSIT'; end if;

  computed_platform := round(camp.total_budget_usdc * 0.10, 6);
  computed_boost := round(coalesce(camp.bundle_boost_fee_usdc, camp.boost_fee_usdc, 0), 6);
  if abs(computed_platform - p_platform_fee) > 0.000001 then raise exception 'BAD_FIELD'; end if;
  if abs(computed_boost - p_boost_fee) > 0.000001 then raise exception 'BAD_FIELD'; end if;

  insert into public.used_transactions (signature, purpose) values (p_tx, 'deposit');

  update public.campaigns
  set status = 'active',
      remaining_budget_usdc = total_budget_usdc,
      platform_fee_usdc = computed_platform,
      boost_fee_usdc = computed_boost,
      deposit_tx_hash = p_tx
  where id = camp.id;

  if p_founder_ip is not null and length(p_founder_ip) > 0 then
    update public.profiles set last_ip = p_founder_ip where id = p_founder_id;
  end if;

  if p_sender_wallet is not null and length(p_sender_wallet) > 0 then
    update public.profiles
    set wallet_address = coalesce(wallet_address, p_sender_wallet)
    where id = p_founder_id;
  end if;

  select referred_by into referrer from public.profiles where id = p_founder_id;
  bonus := round(camp.total_budget_usdc * p_referral_rate, 6);
  if referrer is not null and referrer <> p_founder_id and bonus > 0 then
    select * into ref_profile from public.profiles where id = referrer;
    select * into founder_profile from public.profiles where id = p_founder_id;
    if ref_profile.wallet_address is not null
      and founder_profile.wallet_address is not null
      and ref_profile.wallet_address = founder_profile.wallet_address then
      return 0;
    end if;
    if ref_profile.last_ip is not null
      and founder_profile.last_ip is not null
      and ref_profile.last_ip = founder_profile.last_ip then
      return 0;
    end if;
    update public.profiles
    set available_usdc = available_usdc + bonus
    where id = referrer;
    return bonus;
  end if;
  return 0;
end;
$$;

create or replace function public.atomic_request_payout(
  p_user_id uuid,
  p_amount_usdc numeric,
  p_destination_wallet text
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  prof public.profiles%rowtype;
  request_id uuid;
  gas_fee numeric := 0.15;
  net_amount numeric;
begin
  if p_amount_usdc < 2 then raise exception 'NET_NOT_POSITIVE'; end if;

  select * into prof from public.profiles where id = p_user_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;
  if prof.is_banned then raise exception 'BANNED'; end if;
  if prof.strikes >= 3 then raise exception 'TOO_MANY_STRIKES'; end if;
  if prof.x_followed is not true or prof.tg_joined is not true then raise exception 'SOCIAL_GATES'; end if;
  if prof.available_usdc < p_amount_usdc then raise exception 'INSUFFICIENT_AVAILABLE'; end if;

  net_amount := round(p_amount_usdc - gas_fee, 6);
  if net_amount <= 0 then raise exception 'NET_NOT_POSITIVE'; end if;

  update public.profiles
  set available_usdc = available_usdc - p_amount_usdc
  where id = p_user_id;

  insert into public.payout_requests (
    user_id, request_type, gross_amount_usdc, gas_fee_usdc, net_amount_usdc,
    destination_wallet, status
  ) values (
    p_user_id, 'raider_payout', p_amount_usdc, gas_fee, net_amount, p_destination_wallet, 'queued'
  ) returning id into request_id;

  return request_id;
end;
$$;

create or replace function public.reserve_ad_banner_slot(p_user_id uuid) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  booking_id uuid;
begin
  perform pg_advisory_xact_lock(8142001);

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
    user_id, status, expires_at, starts_at, ends_at
  ) values (
    p_user_id,
    'reserved',
    now() + interval '15 minutes',
    now(),
    now() + interval '15 minutes'
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

  select max(ends_at) into latest
  from public.ad_banner_bookings
  where status in ('active', 'queued');

  if latest is null then
    update public.ad_banner_bookings
    set headline = p_headline,
        image_url = p_image_url,
        target_url = p_target_url,
        tx_signature = p_tx_signature,
        status = 'active',
        expires_at = null,
        starts_at = now(),
        ends_at = now() + interval '24 hours'
    where id = booking.id;
  else
    update public.ad_banner_bookings
    set headline = p_headline,
        image_url = p_image_url,
        target_url = p_target_url,
        tx_signature = p_tx_signature,
        status = 'queued',
        expires_at = null,
        starts_at = latest,
        ends_at = latest + interval '24 hours'
    where id = booking.id;
  end if;

  return booking.id;
end;
$$;

create or replace function public.release_expired_ad_reservations() returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  released integer;
begin
  update public.ad_banner_bookings
  set status = 'expired'
  where status = 'reserved'
    and expires_at is not null
    and expires_at <= now();
  get diagnostics released = row_count;
  return released;
end;
$$;

revoke all on function public.activate_campaign_deposit(uuid, uuid, text, text, numeric, numeric, numeric, text) from public;
revoke all on function public.atomic_request_payout(uuid, numeric, text) from public;
revoke all on function public.reserve_ad_banner_slot(uuid) from public;
revoke all on function public.confirm_ad_banner_booking(uuid, uuid, text, text, text, text) from public;
revoke all on function public.release_expired_ad_reservations() from public;

grant execute on function public.activate_campaign_deposit(uuid, uuid, text, text, numeric, numeric, numeric, text) to service_role;
grant execute on function public.atomic_request_payout(uuid, numeric, text) to service_role;
grant execute on function public.reserve_ad_banner_slot(uuid) to service_role;
grant execute on function public.confirm_ad_banner_booking(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.release_expired_ad_reservations() to service_role;