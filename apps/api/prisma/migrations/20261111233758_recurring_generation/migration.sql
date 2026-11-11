-- Cross-tenant discovery for recurring generation (ADR-0006). Same pattern as
-- the overdue sweep: a read-only policy scoped to app_owner (which never
-- connects at runtime) lets one narrow SECURITY DEFINER function see across
-- tenants, and it returns organization ids only.
CREATE POLICY "system_scan" ON "recurring_templates" FOR SELECT TO app_owner USING (true);

CREATE FUNCTION public.app_orgs_with_due_recurring(as_of date)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT org_id
  FROM public.recurring_templates
  WHERE active AND deleted_at IS NULL AND next_run_on IS NOT NULL AND next_run_on <= as_of
$$;

REVOKE ALL ON FUNCTION public.app_orgs_with_due_recurring(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_orgs_with_due_recurring(date) TO app_user;
