-- Run once in Supabase SQL Editor if eligibility returns 500 / "Something went wrong".
-- Safe on Lovable-originated profiles (adds missing worker columns).

alter table public.profiles add column if not exists x_badge_type text not null default 'none';
alter table public.profiles add column if not exists verification_status text;
alter table public.profiles add column if not exists is_crypto_verified boolean not null default false;
alter table public.profiles add column if not exists account_age_days integer;
alter table public.profiles add column if not exists posts_count integer;
alter table public.profiles add column if not exists ai_verification_notes jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists raider_tier text default 'bronze';

alter table public.profiles add column if not exists badge_multiplier numeric not null default 1;

alter table public.profiles drop constraint if exists profiles_badge_multiplier_range;
alter table public.profiles add constraint profiles_badge_multiplier_range
  check (badge_multiplier between 1 and 2);

create or replace function public.sync_profile_badge_multiplier() returns trigger
language plpgsql
set search_path = public
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