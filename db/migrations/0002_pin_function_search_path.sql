-- 0002 — Pin the search_path of every loopcloser function (LC-M1-T3b).
--
-- A function without its own search_path resolves unqualified names through
-- the caller's, where pg_temp is searched first for relations. The app role
-- can create temporary tables, so it could shadow a protected table a trigger
-- reads (COND-13-review2: a temp loop_state_transitions let a proposed loop
-- move straight to waiting). Every function the migrations define runs with
-- search_path = pg_catalog, public, pg_temp — pg_temp last.
--
-- Invariant for later migrations: every CREATE FUNCTION / CREATE PROCEDURE
-- carries `SET search_path = pg_catalog, public, pg_temp`.
-- tests/schema/function-search-path.test.ts enumerates every function in the
-- loopcloser schemas and fails on any without it.

BEGIN;

ALTER FUNCTION public.loops_enforce_state_machine() SET search_path = pg_catalog, public, pg_temp;

INSERT INTO schema_migrations (version, name) VALUES ('0002', 'pin_function_search_path');

COMMIT;
