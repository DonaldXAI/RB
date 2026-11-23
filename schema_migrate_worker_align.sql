-- =============================================================================
-- RaidHive: align existing Supabase schema with raidhive-backend worker
-- Run once in the SQL editor (service role / postgres).
--
-- Frontend: switch to the worker column names listed in the mapping at the bottom.
-- Safe to re-run partial sections only if a step already succeeded (idempotent
-- where possible). Review errors if a rename was already applied.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. profiles
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'solana_wallet'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'wallet_address'
  ) then
    alter table public.profiles rename column solana_wallet to wallet_address;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'x_handle'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'x_username'
  ) then
    alter table public.profiles rename column x_handle to x_username;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'is_x_following'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'x_followed'
  ) then
    alter table public.profiles rename column is_x_following to x_followed;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'is_telegram_joined'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'tg_joined'
  ) then
    alter table public.profiles rename column is_telegram_joined to tg_joined;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'followers_count'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'x_followers'
  ) then
    alter table public.profiles rename column followers_count to x_followers;
  end if;
end $$;

alter table public.profiles add column if not exists is_banned boolean not null default false;
alter table public.profiles add column if not exists last_ip text;
alter table public.profiles add column if not exists badge_multiplier numeric not null default 1;

alter table public.profiles drop constraint if exists profiles_badge_multiplier_range;
alter table public.profiles add constraint profiles_badge_multiplier_range
  check (badge_multiplier between 1 and 2);

update public.profiles
set badge_multiplier = case coalesce(x_badge_type, 'none')
  when 'gold' then 2.0
  when 'blue' then 1.5
  when 'grey' then 1.25
  else 1.0
end
where badge_multiplier = 1;

create unique index if not exists profiles_wallet_uidx
  on public.profiles (wallet_address)
  where wallet_address is not null;

create unique index if not exists profiles_x_username_uidx
  on public.profiles (lower(x_username))
  where x_username is not null;

create unique index if not exists profiles_telegram_uidx
  on public.profiles (telegram_user_id)
  where telegram_user_id is not null;

create or replace function public.sync_profile_badge_multiplier() returns trigger
language plpgsql
as $$
begin
  new.badge_multiplier := case coalesce(new.x_badge_type, 'none')
    when 'gold' then 2.0
    when 'blue' then 1.5
    when 'grey' then 1.25
    else 1.0
  end;
  return new;
end;
$$;

drop trigger if exists profiles_badge_multiplier_sync on public.profiles;
create trigger profiles_badge_multiplier_sync
before insert or update of x_badge_type on public.profiles
for each row execute function public.sync_profile_badge_multiplier();

-- -----------------------------------------------------------------------------
-- 2. campaigns
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'creator_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'founder_id'
  ) then
    alter table public.campaigns rename column creator_id to founder_id;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'expires_at'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'ends_at'
  ) then
    alter table public.campaigns rename column expires_at to ends_at;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'funding_tx_hash'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'deposit_tx_hash'
  ) then
    alter table public.campaigns rename column funding_tx_hash to deposit_tx_hash;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'action_rewards'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'base_rates'
  ) then
    alter table public.campaigns rename column action_rewards to base_rates;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'instructions'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'brief'
  ) then
    alter table public.campaigns rename column instructions to brief;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'token_ticker'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'ticker_or_hashtag'
  ) then
    alter table public.campaigns rename column token_ticker to ticker_or_hashtag;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'target_x_handle'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'target_username'
  ) then
    alter table public.campaigns rename column target_x_handle to target_username;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'min_followers_required'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'campaigns' and column_name = 'min_followers'
  ) then
    alter table public.campaigns rename column min_followers_required to min_followers;
  end if;
end $$;

alter table public.campaigns add column if not exists bundle_boost_fee_usdc numeric not null default 0;
alter table public.campaigns add column if not exists target_tweet_id text;

update public.campaigns
set brief = coalesce(brief, ''),
    ticker_or_hashtag = coalesce(ticker_or_hashtag, ''),
    base_rates = coalesce(base_rates, '{"post": 1.75, "quote": 1.25, "reply": 0.75, "follow": 0.25, "repost": 0.35}'::jsonb),
    bundle_boost_fee_usdc = coalesce(bundle_boost_fee_usdc, boost_fee_usdc, 0);

update public.campaigns
set target_tweet_id = (regexp_match(target_tweet_url, '(?i)status(?:es)?/(\d+)'))[1]
where target_tweet_id is null
  and target_tweet_url is not null;

alter table public.campaigns drop constraint if exists campaigns_status_check;
alter table public.campaigns add constraint campaigns_status_check
  check (status = any (array[
    'awaiting_deposit'::text, 'active'::text, 'paused'::text, 'hidden'::text,
    'expired'::text, 'refund_queued'::text, 'completed'::text, 'refunded'::text
  ]));

create unique index if not exists campaigns_deposit_tx_hash_uidx
  on public.campaigns (deposit_tx_hash)
  where deposit_tx_hash is not null;

create index if not exists campaigns_status_ends_idx on public.campaigns (status, ends_at);

-- -----------------------------------------------------------------------------
-- 3. submissions
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'submissions' and column_name = 'proof_url'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'submissions' and column_name = 'tweet_url'
  ) then
    alter table public.submissions rename column proof_url to tweet_url;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'submissions' and column_name = 'reward_usdc'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'submissions' and column_name = 'earned_usdc'
  ) then
    alter table public.submissions rename column reward_usdc to earned_usdc;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'submissions' and column_name = 'unlocks_at'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'submissions' and column_name = 'vests_at'
  ) then
    alter table public.submissions rename column unlocks_at to vests_at;
  end if;
end $$;

alter table public.submissions add column if not exists tweet_text text not null default '';
alter table public.submissions add column if not exists ai_reason text not null default '';
alter table public.submissions add column if not exists vested boolean not null default false;

update public.submissions
set status = 'verified',
    vested = false
where status = 'vesting_hold';

update public.submissions
set status = 'verified',
    vested = case when vests_at is not null and vests_at <= now() then true else false end
where status = 'approved';

update public.submissions
set status = 'rejected',
    vested = false
where status = 'pending_check';

update public.submissions
set status = 'rejected',
    vested = false
where status in ('slashed');

update public.submissions
set vested = true
where status = 'verified'
  and vests_at is not null
  and vests_at <= now()
  and vested = false;

alter table public.submissions drop constraint if exists submissions_status_check;
alter table public.submissions add constraint submissions_status_check
  check (status = any (array['rejected'::text, 'verified'::text]));

alter table public.submissions drop constraint if exists submissions_proof_url_check;
alter table public.submissions drop constraint if exists submissions_tweet_url_check;

create unique index if not exists submissions_campaign_raider_uidx
  on public.submissions (campaign_id, raider_id);

create index if not exists submissions_vesting_idx
  on public.submissions (status, vested, vests_at);

-- -----------------------------------------------------------------------------
-- 4. payout_requests
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payout_requests' and column_name = 'recipient_wallet'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payout_requests' and column_name = 'destination_wallet'
  ) then
    alter table public.payout_requests rename column recipient_wallet to destination_wallet;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payout_requests' and column_name = 'gross_usdc_amount'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payout_requests' and column_name = 'gross_amount_usdc'
  ) then
    alter table public.payout_requests rename column gross_usdc_amount to gross_amount_usdc;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payout_requests' and column_name = 'net_usdc_amount'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'payout_requests' and column_name = 'net_amount_usdc'
  ) then
    alter table public.payout_requests rename column net_usdc_amount to net_amount_usdc;
  end if;
end $$;

alter table public.payout_requests add column if not exists request_type text not null default 'raider_payout';
alter table public.payout_requests add column if not exists campaign_id uuid references public.campaigns (id);
alter table public.payout_requests add column if not exists rejection_reason text;
alter table public.payout_requests add column if not exists processed_at timestamptz;

update public.payout_requests
set processed_at = paid_at
where processed_at is null and paid_at is not null;

alter table public.payout_requests drop constraint if exists payout_requests_status_check;
alter table public.payout_requests add constraint payout_requests_status_check
  check (status = any (array['queued'::text, 'processing'::text, 'paid'::text, 'rejected'::text]));

alter table public.payout_requests drop constraint if exists payout_requests_request_type_check;
alter table public.payout_requests add constraint payout_requests_request_type_check
  check (request_type = any (array['raider_payout'::text, 'campaign_refund'::text]));

create index if not exists payout_requests_status_idx on public.payout_requests (status);
create index if not exists payout_requests_user_idx on public.payout_requests (user_id, status);

-- -----------------------------------------------------------------------------
-- 5. ad_banner_bookings
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ad_banner_bookings' and column_name = 'advertiser_user_id'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ad_banner_bookings' and column_name = 'user_id'
  ) then
    alter table public.ad_banner_bookings rename column advertiser_user_id to user_id;
  end if;
end $$;

alter table public.ad_banner_bookings add column if not exists expires_at timestamptz;

alter table public.ad_banner_bookings alter column headline drop not null;
alter table public.ad_banner_bookings alter column image_url drop not null;
alter table public.ad_banner_bookings alter column target_url drop not null;
alter table public.ad_banner_bookings alter column tx_signature drop not null;

update public.ad_banner_bookings
set starts_at = coalesce(starts_at, created_at, now()),
    ends_at = coalesce(ends_at, created_at + interval '24 hours', now() + interval '24 hours')
where starts_at is null or ends_at is null;

alter table public.ad_banner_bookings drop constraint if exists ad_banner_bookings_status_check;
alter table public.ad_banner_bookings add constraint ad_banner_bookings_status_check
  check (status = any (array['queued'::text, 'active'::text, 'completed'::text, 'refunded'::text, 'reserved'::text, 'expired'::text]));

drop index if exists ad_banner_one_active_uidx;
create unique index ad_banner_one_active_uidx
  on public.ad_banner_bookings ((true))
  where status = 'active';

create index if not exists ad_banner_rotation_idx
  on public.ad_banner_bookings (status, starts_at, ends_at);

-- -----------------------------------------------------------------------------
-- 6. used_transactions + admin tables
-- -----------------------------------------------------------------------------
create table if not exists public.used_transactions (
  signature text primary key,
  purpose text not null check (purpose in ('deposit', 'ad', 'payout')),
  created_at timestamptz not null default now()
);

insert into public.used_transactions (signature, purpose, created_at)
select t.tx_hash,
  case t.tx_type
    when 'deposit' then 'deposit'
    when 'payout' then 'payout'
    when 'refund' then 'payout'
    else 'deposit'
  end,
  t.created_at
from public.transactions t
where t.tx_hash is not null
  and t.status = 'confirmed'
on conflict (signature) do nothing;

alter table public.admin_nonces add column if not exists admin_wallet text;
alter table public.admin_nonces add column if not exists message_timestamp timestamptz;
alter table public.admin_nonces add column if not exists created_at timestamptz not null default now();

update public.admin_nonces
set created_at = coalesce(created_at, used_at, now()),
    message_timestamp = coalesce(message_timestamp, used_at, now())
where message_timestamp is null or created_at is null;

update public.admin_audit_logs
set details = coalesce(details, '{}'::jsonb)
where details is null;

alter table public.admin_audit_logs alter column details set default '{}'::jsonb;

alter table public.used_transactions enable row level security;
alter table public.admin_nonces enable row level security;
alter table public.admin_audit_logs enable row level security;

commit;

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

-- =============================================================================
-- Frontend column mapping (use these names in API types / Supabase queries)
-- -----------------------------------------------------------------------------
-- profiles:     wallet_address, x_username, x_followed, tg_joined, x_followers,
--               badge_multiplier, is_banned, last_ip
-- campaigns:    founder_id, ends_at, deposit_tx_hash, base_rates, brief,
--               ticker_or_hashtag, target_username, target_tweet_id, min_followers
-- submissions: tweet_url, tweet_text, earned_usdc, vests_at, vested, ai_reason
--               status in ('verified','rejected')
-- payouts:      destination_wallet, gross_amount_usdc, net_amount_usdc,
--               request_type, payout_tx_hash, processed_at, rejection_reason
-- ads:          user_id, reservation via status 'reserved', book with reservationId
-- =============================================================================