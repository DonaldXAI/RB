
-- Run PART 2 only after PART 1 succeeds.
-- =============================================================================
-- 7. Worker RPCs (run after column alignment)
-- =============================================================================

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
    update public.profiles set available_usdc = available_usdc + bonus where id = referrer;
    return bonus;
  end if;
  return 0;
end;
$$;

create or replace function public.queue_campaign_refund(
  p_campaign_id uuid,
  p_user_id uuid,
  p_gas_fee numeric
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  camp public.campaigns%rowtype;
  destination text;
  request_id uuid;
  net numeric;
begin
  select * into camp from public.campaigns where id = p_campaign_id for update;
  if not found or camp.founder_id <> p_user_id then raise exception 'NOT_OWNER'; end if;
  if camp.status not in ('active', 'expired') then raise exception 'NOT_REFUNDABLE'; end if;
  if camp.ends_at > now() then raise exception 'NOT_EXPIRED'; end if;
  if camp.remaining_budget_usdc <= p_gas_fee then raise exception 'FEE_EXCEEDS_BUDGET'; end if;
  if exists (
    select 1 from public.payout_requests
    where campaign_id = p_campaign_id and request_type = 'campaign_refund' and status = 'queued'
  ) then
    raise exception 'REFUND_ALREADY_QUEUED';
  end if;

  select wallet_address into destination from public.profiles where id = p_user_id;
  if destination is null then raise exception 'WALLET_REQUIRED'; end if;

  net := round(camp.remaining_budget_usdc - p_gas_fee, 6);
  insert into public.payout_requests (
    user_id, campaign_id, request_type, gross_amount_usdc, gas_fee_usdc, net_amount_usdc,
    destination_wallet, status
  ) values (
    p_user_id, p_campaign_id, 'campaign_refund', camp.remaining_budget_usdc, p_gas_fee, net,
    destination, 'queued'
  ) returning id into request_id;

  update public.campaigns
  set remaining_budget_usdc = 0, status = 'refund_queued'
  where id = camp.id;

  return request_id;
end;
$$;

create or replace function public.apply_verified_raid(
  p_campaign_id uuid,
  p_raider_id uuid,
  p_amount numeric,
  p_min_rate numeric,
  p_action_type text,
  p_tweet_url text,
  p_tweet_text text,
  p_ai_reason text,
  p_vests_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  submission_id uuid;
begin
  update public.campaigns
  set remaining_budget_usdc = remaining_budget_usdc - p_amount,
      status = case
        when status = 'active' and remaining_budget_usdc - p_amount < p_min_rate then 'completed'
        else status
      end
  where id = p_campaign_id
    and status = 'active'
    and ends_at > now()
    and remaining_budget_usdc >= p_amount;

  if not found then raise exception 'BUDGET_NOT_RESERVED'; end if;

  insert into public.submissions (
    campaign_id, raider_id, action_type, tweet_url, tweet_text,
    status, ai_reason, earned_usdc, vests_at, vested
  ) values (
    p_campaign_id, p_raider_id, p_action_type, p_tweet_url, p_tweet_text,
    'verified', coalesce(p_ai_reason, ''), p_amount, p_vests_at, false
  ) returning id into submission_id;

  update public.profiles set pending_usdc = pending_usdc + p_amount where id = p_raider_id;
  return submission_id;
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

  update public.profiles set available_usdc = available_usdc - p_amount_usdc where id = p_user_id;

  insert into public.payout_requests (
    user_id, request_type, gross_amount_usdc, gas_fee_usdc, net_amount_usdc,
    destination_wallet, status
  ) values (
    p_user_id, 'raider_payout', p_amount_usdc, gas_fee, net_amount, p_destination_wallet, 'queued'
  ) returning id into request_id;

  return request_id;
end;
$$;

create or replace function public.release_vested_submission(
  p_submission_id uuid,
  p_referral_bonus numeric
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  sub public.submissions%rowtype;
  referrer uuid;
  prior_vested integer;
begin
  select * into sub from public.submissions where id = p_submission_id for update;
  if not found then return false; end if;
  if sub.status <> 'verified' or sub.vested or sub.vests_at is null or sub.vests_at > now() then
    return false;
  end if;

  select referred_by into referrer from public.profiles where id = sub.raider_id for update;
  select count(*) into prior_vested
  from public.submissions
  where raider_id = sub.raider_id and vested = true and id <> sub.id;

  update public.profiles
  set pending_usdc = pending_usdc - sub.earned_usdc,
      available_usdc = available_usdc + sub.earned_usdc
  where id = sub.raider_id and pending_usdc >= sub.earned_usdc;
  if not found then raise exception 'PENDING_TOO_LOW'; end if;

  update public.submissions set vested = true where id = sub.id;

  if prior_vested = 0 and referrer is not null and p_referral_bonus > 0 then
    update public.profiles set available_usdc = available_usdc + p_referral_bonus where id = referrer;
  end if;

  return true;
end;
$$;

create or replace function public.confirm_payout_batch(p_ids uuid[], p_tx text) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  queued_count integer;
  updated_count integer;
begin
  if exists (select 1 from public.used_transactions where signature = p_tx)
     or exists (
       select 1 from public.payout_requests
       where payout_tx_hash = p_tx and not (id = any(p_ids))
     ) then
    raise exception 'TX_USED';
  end if;

  perform 1 from public.payout_requests where id = any(p_ids) for update;

  select count(*) into queued_count
  from public.payout_requests
  where id = any(p_ids) and status = 'queued';

  if queued_count <> cardinality(p_ids) then raise exception 'PAYOUT_NOT_QUEUED'; end if;

  insert into public.used_transactions (signature, purpose) values (p_tx, 'payout');

  update public.payout_requests
  set status = 'paid', payout_tx_hash = p_tx, processed_at = now()
  where id = any(p_ids) and status = 'queued';

  get diagnostics updated_count = row_count;
  if updated_count <> cardinality(p_ids) then raise exception 'PAYOUT_NOT_QUEUED'; end if;
  return updated_count;
end;
$$;

create or replace function public.reject_payout_request(
  p_request_id uuid,
  p_reason text,
  p_refund boolean
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  req public.payout_requests%rowtype;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'BAD_DECISION'; end if;

  select * into req from public.payout_requests where id = p_request_id for update;
  if not found then raise exception 'PAYOUT_NOT_QUEUED'; end if;
  if req.status <> 'queued' then raise exception 'PAYOUT_NOT_QUEUED'; end if;

  update public.payout_requests
  set status = 'rejected', rejection_reason = p_reason, processed_at = now()
  where id = req.id;

  if p_refund and req.request_type = 'raider_payout' then
    update public.profiles set available_usdc = available_usdc + req.gross_amount_usdc where id = req.user_id;
  elsif p_refund and req.request_type = 'campaign_refund' then
    update public.campaigns
    set remaining_budget_usdc = remaining_budget_usdc + req.gross_amount_usdc,
        status = 'active',
        ends_at = now() + interval '24 hours'
    where id = req.campaign_id;
  elsif req.request_type = 'campaign_refund' then
    update public.campaigns set status = 'expired'
    where id = req.campaign_id and status = 'refund_queued';
  end if;

  return jsonb_build_object('status', 'rejected', 'refunded', p_refund, 'request_type', req.request_type);
end;
$$;

create or replace function public.override_submission(
  p_submission_id uuid,
  p_decision text,
  p_reason text,
  p_vests_at timestamptz,
  p_min_rate numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sub public.submissions%rowtype;
begin
  if p_decision not in ('approve', 'reject_strike') then raise exception 'BAD_DECISION'; end if;

  select * into sub from public.submissions where id = p_submission_id for update;
  if not found then raise exception 'SUBMISSION_NOT_FOUND'; end if;

  perform 1 from public.profiles where id = sub.raider_id for update;

  if p_decision = 'approve' then
    if sub.status = 'verified' then raise exception 'ALREADY_VERIFIED'; end if;
    if sub.earned_usdc <= 0 then raise exception 'NO_PAYOUT_AMOUNT'; end if;

    update public.campaigns
    set remaining_budget_usdc = remaining_budget_usdc - sub.earned_usdc,
        status = case
          when status = 'active' and remaining_budget_usdc - sub.earned_usdc < p_min_rate then 'completed'
          else status
        end
    where id = sub.campaign_id
      and status in ('active', 'paused', 'hidden', 'expired', 'completed')
      and remaining_budget_usdc >= sub.earned_usdc;
    if not found then raise exception 'BUDGET_NOT_RESERVED'; end if;

    update public.submissions
    set status = 'verified', vested = false, vests_at = p_vests_at, ai_reason = p_reason
    where id = sub.id;

    update public.profiles set pending_usdc = pending_usdc + sub.earned_usdc where id = sub.raider_id;

    return jsonb_build_object('status', 'verified', 'earned_usdc', sub.earned_usdc, 'vests_at', p_vests_at);
  end if;

  if sub.status = 'verified' and sub.vested = false then
    update public.profiles
    set pending_usdc = pending_usdc - sub.earned_usdc, strikes = strikes + 1
    where id = sub.raider_id and pending_usdc >= sub.earned_usdc;
    if not found then raise exception 'PENDING_TOO_LOW'; end if;

    update public.campaigns set remaining_budget_usdc = remaining_budget_usdc + sub.earned_usdc
    where id = sub.campaign_id;
  elsif sub.status = 'verified' and sub.vested = true then
    update public.profiles
    set available_usdc = greatest(0, available_usdc - sub.earned_usdc), strikes = strikes + 1
    where id = sub.raider_id;
  else
    update public.profiles set strikes = strikes + 1 where id = sub.raider_id;
  end if;

  update public.submissions set status = 'rejected', ai_reason = p_reason where id = sub.id;
  return jsonb_build_object('status', 'rejected');
end;
$$;

create or replace function public.moderate_user(p_user_id uuid, p_action text) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_strikes integer;
  banned boolean;
begin
  select strikes, is_banned into new_strikes, banned from public.profiles where id = p_user_id for update;
  if not found then raise exception 'PROFILE_NOT_FOUND'; end if;

  if p_action = 'add_strike' then
    update public.profiles set strikes = strikes + 1 where id = p_user_id returning strikes, is_banned into new_strikes, banned;
  elsif p_action = 'reset_strikes' then
    update public.profiles set strikes = 0 where id = p_user_id returning strikes, is_banned into new_strikes, banned;
  elsif p_action = 'ban' then
    update public.profiles set is_banned = true where id = p_user_id returning strikes, is_banned into new_strikes, banned;
  elsif p_action = 'unban' then
    update public.profiles set is_banned = false where id = p_user_id returning strikes, is_banned into new_strikes, banned;
  else
    raise exception 'BAD_ACTION';
  end if;

  return jsonb_build_object('id', p_user_id, 'strikes', new_strikes, 'is_banned', banned);
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
    where status = 'reserved' and expires_at > now() and user_id <> p_user_id
  ) then
    raise exception 'RESERVATION_IN_USE';
  end if;

  if exists (
    select 1 from public.ad_banner_bookings
    where user_id = p_user_id and status = 'reserved' and expires_at > now()
  ) then
    select id into booking_id
    from public.ad_banner_bookings
    where user_id = p_user_id and status = 'reserved' and expires_at > now()
    order by created_at desc limit 1;
    return booking_id;
  end if;

  insert into public.ad_banner_bookings (user_id, status, expires_at, starts_at, ends_at)
  values (p_user_id, 'reserved', now() + interval '15 minutes', now(), now() + interval '15 minutes')
  returning id into booking_id;

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
  where id = p_reservation_id and user_id = p_user_id and status = 'reserved'
  for update;

  if not found then raise exception 'RESERVATION_NOT_FOUND'; end if;
  if booking.expires_at is null or booking.expires_at <= now() then raise exception 'RESERVATION_EXPIRED'; end if;

  insert into public.used_transactions (signature, purpose) values (p_tx_signature, 'ad');

  select max(ends_at) into latest from public.ad_banner_bookings where status in ('active', 'queued');

  if latest is null then
    update public.ad_banner_bookings
    set headline = p_headline, image_url = p_image_url, target_url = p_target_url,
        tx_signature = p_tx_signature, status = 'active', expires_at = null,
        starts_at = now(), ends_at = now() + interval '24 hours'
    where id = booking.id;
  else
    update public.ad_banner_bookings
    set headline = p_headline, image_url = p_image_url, target_url = p_target_url,
        tx_signature = p_tx_signature, status = 'queued', expires_at = null,
        starts_at = latest, ends_at = latest + interval '24 hours'
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
  where status = 'reserved' and expires_at is not null and expires_at <= now();
  get diagnostics released = row_count;
  return released;
end;
$$;

create or replace function public.bump_ad_stat(p_id uuid, p_field text) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  total bigint;
begin
  if p_field = 'impressions' then
    update public.ad_banner_bookings set impressions = impressions + 1 where id = p_id returning impressions into total;
  elsif p_field = 'clicks' then
    update public.ad_banner_bookings set clicks = clicks + 1 where id = p_id returning clicks into total;
  else
    raise exception 'BAD_FIELD';
  end if;
  if not found then raise exception 'AD_NOT_FOUND'; end if;
  return total;
end;
$$;

revoke all on function public.activate_campaign_deposit(uuid, uuid, text, text, numeric, numeric, numeric, text) from public;
revoke all on function public.queue_campaign_refund(uuid, uuid, numeric) from public;
revoke all on function public.apply_verified_raid(uuid, uuid, numeric, numeric, text, text, text, text, timestamptz) from public;
revoke all on function public.atomic_request_payout(uuid, numeric, text) from public;
revoke all on function public.release_vested_submission(uuid, numeric) from public;
revoke all on function public.confirm_payout_batch(uuid[], text) from public;
revoke all on function public.reject_payout_request(uuid, text, boolean) from public;
revoke all on function public.override_submission(uuid, text, text, timestamptz, numeric) from public;
revoke all on function public.moderate_user(uuid, text) from public;
revoke all on function public.reserve_ad_banner_slot(uuid) from public;
revoke all on function public.confirm_ad_banner_booking(uuid, uuid, text, text, text, text) from public;
revoke all on function public.release_expired_ad_reservations() from public;
revoke all on function public.bump_ad_stat(uuid, text) from public;

grant execute on function public.activate_campaign_deposit(uuid, uuid, text, text, numeric, numeric, numeric, text) to service_role;
grant execute on function public.queue_campaign_refund(uuid, uuid, numeric) to service_role;
grant execute on function public.apply_verified_raid(uuid, uuid, numeric, numeric, text, text, text, text, timestamptz) to service_role;
grant execute on function public.atomic_request_payout(uuid, numeric, text) to service_role;
grant execute on function public.release_vested_submission(uuid, numeric) to service_role;
grant execute on function public.confirm_payout_batch(uuid[], text) to service_role;
grant execute on function public.reject_payout_request(uuid, text, boolean) to service_role;
grant execute on function public.override_submission(uuid, text, text, timestamptz, numeric) to service_role;
grant execute on function public.moderate_user(uuid, text) to service_role;
grant execute on function public.reserve_ad_banner_slot(uuid) to service_role;
grant execute on function public.confirm_ad_banner_booking(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.release_expired_ad_reservations() to service_role;
grant execute on function public.bump_ad_stat(uuid, text) to service_role;
