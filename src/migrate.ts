// Migrate entrypoint (LC-RUN-MIGRATE): `node dist/migrate.js` in the image.
//
//   DATABASE_URL    required; the migration role's connection URL (on the estate,
//                   key `uri` of the CNPG `loopcloser-db-app` secret).
//   MIGRATIONS_DIR  optional; defaults to db/migrations under the app root.
//
// Exit 0: every migration is applied (or none was missing). Exit 1: a migration
// failed (rolled back, unrecorded, later ones not run) or the database was
// refused. Exit 2: usage error.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate, readMigrations } from "./db/migrate.ts";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseUrl = process.env.DATABASE_URL;
const dir = process.env.MIGRATIONS_DIR || resolve(appRoot, "db", "migrations");

if (!databaseUrl) {
  console.error("migrate: DATABASE_URL is not set");
  process.exit(2);
}

const client = new pg.Client({ connectionString: databaseUrl, application_name: "loopcloser-migrate" });
try {
  const migrations = readMigrations(dir);
  await client.connect();
  const applied = await migrate(client, migrations, (line) => console.log(`migrate: ${line}`));
  console.log(applied.length === 0 ? "migrate: schema is up to date" : `migrate: applied ${applied.length} migration(s)`);
} catch (err) {
  console.error(`migrate: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
