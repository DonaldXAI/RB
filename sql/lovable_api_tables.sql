-- Minimal tables/columns for Lovable-facing APIs (run in Supabase SQL editor).

create table if not exists public.campaign_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  campaign_id uuid references public.campaigns (id) on delete set null,
  draft jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists campaign_drafts_user_idx on public.campaign_drafts (user_id, updated_at desc);

create table if not exists public.saved_campaigns (
  user_id uuid not null references public.profiles (id) on delete cascade,
  campaign_id uuid not null references public.campaigns (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, campaign_id)
);

create index if not exists saved_campaigns_user_idx on public.saved_campaigns (user_id, created_at desc);

alter table public.campaigns
  add column if not exists project_name text,
  add column if not exists project_handle text;

create index if not exists campaigns_project_handle_idx
  on public.campaigns (lower(project_handle))
  where project_handle is not null;