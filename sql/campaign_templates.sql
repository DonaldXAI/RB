-- Run once in Supabase SQL Editor
create table if not exists public.campaign_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 60),
  draft jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaign_templates_user_idx on public.campaign_templates (user_id, updated_at desc);

alter table public.campaign_templates enable row level security;
revoke all on table public.campaign_templates from anon, authenticated;

-- All access via Render (service_role). Run sql/campaign_templates_worker_only.sql on existing DBs.