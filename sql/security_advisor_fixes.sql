-- Supabase Security Advisor fixes (run in SQL Editor after security_rls_hardening.sql)
-- Clears: Function Search Path Mutable, public/authenticated EXECUTE on SECURITY DEFINER RPCs

-- 1) Trigger already fixed in security_rls_hardening.sql (search_path = public).
-- Re-apply if advisor still flags profiles_block_sensitive_client_update:
create or replace function public.profiles_block_sensitive_client_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
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
    or new.x_badge_type is distinct from old.x_badge_type
  then
    raise exception 'FORBIDDEN';
  end if;
  return new;
end;
$$;

-- 2) Legacy Lovable RPCs — not used by Render worker; block browser execution
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any (array[
        'get_activity_feed',
        'get_creator_submissions',
        'get_leaderboard',
        'lock_wallet_address',
        'protect_profile_sensitive_columns',
        'ensure_profile',
        'request_verification'
      ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
    raise notice 'locked function %', r.sig;
  end loop;
end $$;

-- 3) Optional: fix search_path on other public SECURITY DEFINER functions (advisor)
do $$
declare
  fn record;
  def text;
begin
  for fn in
    select p.oid::regprocedure as sig, pg_get_functiondef(p.oid) as src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and p.proname in (
        'protect_profile_sensitive_columns',
        'lock_wallet_address',
        'ensure_profile',
        'request_verification',
        'get_activity_feed',
        'get_creator_submissions',
        'get_leaderboard'
      )
  loop
    if fn.src is not null and fn.src !~* 'set\s+search_path' then
      raise notice 'Manual review: add SET search_path = public to %', fn.sig;
    end if;
  end loop;
end $$;