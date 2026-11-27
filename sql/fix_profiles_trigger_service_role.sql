-- Run this in Supabase SQL Editor NOW if Render logs show:
--   [db] mark eligibility pending: FORBIDDEN
--   [auth] last_ip update failed: FORBIDDEN
--
-- Cause: profiles trigger blocked Render (service_role) because auth.uid() is null.

create or replace function public.profiles_block_sensitive_client_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Render worker uses SUPABASE_SERVICE_ROLE_KEY — must bypass all checks below.
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