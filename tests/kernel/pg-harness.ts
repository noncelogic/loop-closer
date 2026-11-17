// Test helper (LC-RUN-PG-CLIENT): fresh, migrated databases on a real local
// Postgres container, reached through the Node Postgres client recorded in
// docs/decisions/postgres-client.md (`pg`). The container is an isolated
// Compose replica (tests/schema/replica.ts: empty volume, ephemeral port,
// local-only credentials). Never PGlite or SQLite.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { migrationFiles, migrationsDir, Replica } from "../schema/replica.ts";

export interface FreshDatabase {
  /** The database's name on the replica. */
  readonly name: string;
  /** Host-side connection URL (the owner / migration role). */
  readonly url: string;
  /** A pool connected as the owner (the migration role). */
  readonly pool: pg.Pool;
  /** A new pool whose connections act as loopcloser_app, with only its grants. */
  appPool(max?: number): pg.Pool;
}

export class PgHarness {
  readonly replica: Replica;
  #pools: pg.Pool[] = [];
  #databases = 0;

  constructor(label: string) {
    this.replica = new Replica(label);
  }

  up(): void {
    this.replica.up();
  }

  /** Ends every pool the harness opened, then removes the replica and its volume. */
  async down(): Promise<void> {
    try {
      await Promise.all(this.#pools.splice(0).map((p) => p.end()));
    } finally {
      this.replica.down();
    }
  }

  /**
   * Creates a new database and applies, in order, every migration whose
   * version is at most `through` (all of them when omitted), each through
   * the `pg` client as the owner role.
   */
  async freshDatabase(opts: { through?: string } = {}): Promise<FreshDatabase> {
    const files = migrationFiles().filter((f) => opts.through === undefined || f.slice(0, 4) <= opts.through);
    if (opts.through !== undefined && !files.some((f) => f.startsWith(`${opts.through}_`))) {
      throw new Error(`no migration ${opts.through} in ${migrationsDir}`);
    }
    const name = `lc_harness_${process.pid}_${++this.#databases}`;
    const admin = new pg.Client({ connectionString: this.replica.databaseUrl("loopcloser") });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name}`);
    } finally {
      await admin.end();
    }

    const url = this.replica.databaseUrl(name);
    const migrator = new pg.Client({ connectionString: url });
    await migrator.connect();
    try {
      for (const file of files) {
        try {
          await migrator.query(readFileSync(join(migrationsDir, file), "utf8"));
        } catch (err) {
          throw new Error(`migration ${file} failed on ${name}: ${(err as Error).message}`, { cause: err });
        }
      }
    } finally {
      await migrator.end();
    }

    const pool = this.#track(new pg.Pool({ connectionString: url, max: 2 }));
    return {
      name,
      url,
      pool,
      appPool: (max = 4) => {
        const app = this.#track(new pg.Pool({ connectionString: url, max }));
        app.on("connect", (client) => void client.query("SET ROLE loopcloser_app"));
        return app;
      },
    };
  }

  #track(pool: pg.Pool): pg.Pool {
    this.#pools.push(pool);
    return pool;
  }
}
