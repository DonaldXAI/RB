-- =============================================================================
-- RaidHive production RLS hardening (run in Supabase SQL editor)
-- Goal: block direct client (anon/authenticated) access to money paths; worker
-- uses service_role and bypasses RLS.
-- Safe to re-run: drops named policies before recreate.
-- =============================================================================

-- 1) Enable RLS on worker + Lovable tables
alter table if exists public.profiles enable row level security;
alter table if exists public.campaigns enable row level security;
alter table if exists public.submissions enable row level security;
alter table if exists public.payout_requests enable row level security;
alter table if exists public.ad_banner_bookings enable row level security;
alter table if exists public.used_transactions enable row level security;
alter table if exists public.admin_nonces enable row level security;
alter table if exists public.admin_audit_logs enable row level security;
alter table if exists public.campaign_templates enable row level security;
alter table if exists public.campaign_drafts enable row level security;
alter table if exists public.saved_campaigns enable row level security;

-- 2) Revoke broad table access from browser keys (service_role unchanged)
revoke all on table public.campaigns from anon, authenticated;
revoke all on table public.submissions from anon, authenticated;
revoke all on table public.payout_requests from anon, authenticated;
revoke all on table public.used_transactions from anon, authenticated;
revoke all on table public.admin_nonces from anon, authenticated;
revoke all on table public.admin_audit_logs from anon, authenticated;
revoke all on table public.ad_banner_bookings from anon, authenticated;
revoke all on table public.campaign_templates from anon, authenticated;
revoke all on table public.campaign_drafts from anon, authenticated;
revoke all on table public.saved_campaigns from anon, authenticated;

-- profiles: read own row only; no client updates to balances / strikes (Render worker only)
revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own
  on public.profiles for select
  to authenticated
  using (id = auth.uid());

-- Optional: allow users to update non-financial display fields only via trigger guard
create or replace function public.profiles_block_sensitive_client_update()
returns trigger language plpgsql as $$
begin
  if current_setting('request.jwt.claim.role', true) = 'service_role' then
    return new;
  end if;
  if auth.uid() is distinct from old.id then
  raise exception 'FORBIDDEN';
  end if;
  if new.available_usdc is distinct from old.available_usdc
    or new.pending_usdc is distinct from old.pending_usdc
    or new.strikes is distinct from old.strikes
    or new.is_banned is distinct from old.is_banned
    or new.badge_multiplier is distinct from old.badge_multiplier
  then
    raise exception 'FORBIDDEN';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_block_sensitive_client_update on public.profiles;
create trigger profiles_block_sensitive_client_update
  before update on public.profiles
  for each row execute function public.profiles_block_sensitive_client_update();

drop policy if exists profiles_update_own_safe on public.profiles;
create policy profiles_update_own_safe
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

grant update on table public.profiles to authenticated;

-- 3) campaign_templates, drafts, saved: worker-only (Render API + service_role)
drop policy if exists campaign_templates_select_own on public.campaign_templates;
drop policy if exists campaign_templates_insert_own on public.campaign_templates;
drop policy if exists campaign_templates_delete_own on public.campaign_templates;

-- ad banners: public read via Render GET /api/ads/slots only

-- 4) Revoke execute on money RPCs from public roles (idempotent; adjust if function missing)
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'activate_campaign_deposit',
        'queue_campaign_refund',
        'apply_verified_raid',
        'queue_raider_payout',
        'release_vested_submission',
        'confirm_payout_batch',
        'reject_payout_request',
        'override_submission',
        'moderate_user',
        'atomic_request_payout',
        'reserve_ad_banner_slot',
        'confirm_ad_banner_booking',
        'release_expired_ad_reservations',
        'bump_ad_stat'
      ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;