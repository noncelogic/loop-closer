// Shared harness for the schema contract tests (LC-M1-T3): boots a fresh,
// isolated Compose replica (empty volume, ephemeral port), applies the
// versioned migrations in db/migrations in order, and runs SQL through psql
// inside the container — no Postgres client dependency on the host.
//
// Requires Docker with the Compose plugin, like tests/foundation/local-replica.test.ts.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
export const migrationsDir = join(repoRoot, "db", "migrations");

/** Versioned schema files, in apply order (`NNNN_name.sql`). */
export function migrationFiles(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort();
}

export class Replica {
  readonly project: string;

  constructor(label: string) {
    this.project = `loopcloser-${label}-${process.pid}`;
  }

  #compose(args: string[], opts: { inherit?: boolean; input?: string } = {}): string {
    return (
      execFileSync("docker", ["compose", "--project-name", this.project, ...args], {
        cwd: repoRoot,
        encoding: "utf8",
        input: opts.input,
        stdio: opts.inherit ? "inherit" : ["pipe", "pipe", "pipe"],
        env: { ...process.env, LOOPCLOSER_PG_PORT: "0" },
      }) ?? ""
    );
  }

  up(): void {
    this.#compose(["up", "--detach", "--wait", "--wait-timeout", "120"], { inherit: true });
  }

  down(): void {
    this.#compose(["down", "--volumes", "--remove-orphans"], { inherit: true });
  }

  /** Runs SQL as the database owner (the migration role); returns unaligned tuples-only output. */
  psql(sql: string, opts: { role?: string } = {}): string {
    const script = opts.role ? `SET ROLE ${opts.role};\n${sql}` : sql;
    return this.#compose(
      ["exec", "-T", "postgres", "psql", "-U", "loopcloser", "-d", "loopcloser", "-v", "ON_ERROR_STOP=1", "-qtA", "-f", "-"],
      { input: script },
    ).trim();
  }

  /** Runs SQL expected to fail; returns the error text psql printed. */
  psqlError(sql: string, opts: { role?: string } = {}): string {
    try {
      this.psql(sql, opts);
    } catch (err) {
      const e = err as { stderr?: string };
      return String(e.stderr ?? err);
    }
    throw new Error(`expected SQL to fail but it succeeded:\n${sql}`);
  }

  /** Applies, in order, every schema file whose version is not yet in schema_migrations. */
  migrate(): void {
    const tracked = this.psql("select to_regclass('public.schema_migrations') is not null") === "t";
    const applied = new Set(tracked ? this.psql("select version from schema_migrations").split("\n") : []);
    for (const file of migrationFiles()) {
      if (applied.has(file.slice(0, 4))) continue;
      this.psql(readFileSync(join(migrationsDir, file), "utf8"));
    }
  }
}

/** Minimal valid rows for exercising the schema. */
export const seedSql = `
INSERT INTO nodes (id, kind, created_at, status, attributes) VALUES
  ('lc_who_joe', 'who', now(), 'active', '{"who_type":"person","name":"Joe"}'),
  ('lc_what_packet', 'what', now(), 'active', '{"what_type":"deliverable"}'),
  ('lc_when_reply', 'when', now(), 'active', '{"when_type":"event","event_type":"reply_received"}');
INSERT INTO loops (id, name, loop_type, state, accountable_who_id, closing_when_id, authority,
                   ageing_policy_id, ageing_policy_version, escalation_policy_id, escalation_policy_version)
VALUES ('lc_loop_1', 'Publish packet', 'publishing', 'proposed', 'lc_who_joe', 'lc_when_reply',
        'joe-approves-each', 'lc_policy_ageing_default', 1, 'lc_policy_escalation_default', 1);
INSERT INTO loop_members (loop_id, node_id) VALUES
  ('lc_loop_1', 'lc_who_joe'), ('lc_loop_1', 'lc_what_packet'), ('lc_loop_1', 'lc_when_reply');
INSERT INTO ledger_events (id, at, actor, event_type, subject_ids, payload, idempotency_key)
VALUES ('lc_evt_1', now(), 'agent:juno', 'loop_proposed', ARRAY['lc_loop_1'], '{"rationale":"test"}', NULL);
`;
