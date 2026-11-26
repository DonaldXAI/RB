-- Run after security_rls_hardening.sql (or instead of old campaign_templates RLS policies).
-- Templates are Render-only: GET/POST /api/campaigns/templates, POST .../templates/delete.

alter table if exists public.campaign_templates enable row level security;

drop policy if exists campaign_templates_select_own on public.campaign_templates;
drop policy if exists campaign_templates_insert_own on public.campaign_templates;
drop policy if exists campaign_templates_delete_own on public.campaign_templates;

revoke all on table public.campaign_templates from anon, authenticated;