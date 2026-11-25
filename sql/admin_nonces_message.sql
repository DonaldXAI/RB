-- Run once in Supabase if admin_nonces exists without message column.
alter table public.admin_nonces add column if not exists message text;

update public.admin_nonces set message = '' where message is null;

alter table public.admin_nonces alter column message set default '';
alter table public.admin_nonces alter column message set not null;