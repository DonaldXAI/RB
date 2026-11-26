-- Clears Supabase "RLS Enabled No Policy" INFO on worker-only tables.
-- Render (service_role) bypasses RLS; browsers cannot read/write these tables.

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'admin_audit_logs',
    'admin_nonces',
    'used_transactions',
    'campaign_templates',
    'campaign_drafts',
    'saved_campaigns'
  ]
  loop
    execute format('drop policy if exists client_no_access on public.%I', tbl);
    execute format(
      'create policy client_no_access on public.%I for all to anon, authenticated using (false) with check (false)',
      tbl
    );
  end loop;
end $$;