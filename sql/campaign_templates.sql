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

create policy campaign_templates_select_own
  on public.campaign_templates for select
  to authenticated
  using (user_id = auth.uid());

create policy campaign_templates_insert_own
  on public.campaign_templates for insert
  to authenticated
  with check (user_id = auth.uid());

create policy campaign_templates_delete_own
  on public.campaign_templates for delete
  to authenticated
  using (user_id = auth.uid());

-- Worker uses service_role (bypasses RLS); policies help direct client reads if any.