-- Run once in Supabase SQL Editor (optional; worker falls back to ai_verification_notes JSON).
alter table public.profiles
  add column if not exists notification_preferences jsonb not null default '{}'::jsonb;