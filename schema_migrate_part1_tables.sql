-- Run PART 1 first in Supabase SQL Editor, then PART 2.
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
