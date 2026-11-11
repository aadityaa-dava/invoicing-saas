-- Cross-tenant discovery for the overdue sweep (ADR-0006).
--
-- Row-level security is forced, so it applies to the table owner as well. The
-- function below runs as its owner (SECURITY DEFINER), so it needs one explicit
-- read-only policy. The policy is scoped to app_owner, a role that only runs
-- migrations and never connects at runtime: app_user is unaffected.
CREATE POLICY "system_scan" ON "invoices" FOR SELECT TO app_owner USING (true);

-- Returns organization ids only, never invoice data. The date is a parameter so
-- behaviour is deterministic and testable.
CREATE FUNCTION public.app_orgs_with_overdue_invoices(as_of date)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT org_id
  FROM public.invoices
  WHERE status = 'sent' AND due_date < as_of AND deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION public.app_orgs_with_overdue_invoices(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_orgs_with_overdue_invoices(date) TO app_user;
