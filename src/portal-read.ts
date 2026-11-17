// The scheduled portal-read entrypoint: `node dist/portal-read.js`.
//
// Runs one listings poll (src/sensors/portal-run.ts) against PgGraphStore at
// DATABASE_URL, reading each listing's public directory page configured in
// LISTINGS_DIRECTORY_PAGES, prints the report as one JSON line, closes the
// pool and exits. The listing state compared against is what earlier
// invocations recorded in the graph. Any failure — no DATABASE_URL, no
// listing configured, an unreachable database, a failed read — exits non-zero
// so the scheduled Job fails visibly; a failed read records no heartbeat.
import pg from "pg";
import { CONFIG_ENV } from "./config.ts";
import { PgGraphStore } from "./kernel/pg-store.ts";
import { loadPublicListingConfig, PUBLIC_LISTING_ENV, PublicListingReader } from "./sensors/public-listing.ts";
import { runPortalRead } from "./sensors/portal-run.ts";

async function main(): Promise<void> {
  const databaseUrl = process.env[CONFIG_ENV.databaseUrl];
  if (!databaseUrl) throw new Error(`${CONFIG_ENV.databaseUrl} is not set`);
  const listings = loadPublicListingConfig();
  if (!listings) throw new Error(`${PUBLIC_LISTING_ENV.pages} is not set: no listing to read`);
  const reader = new PublicListingReader(listings);

  const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  pool.on("error", (err) => console.error(`database pool error: ${err.message}`));
  try {
    const report = await runPortalRead(new PgGraphStore(pool), { read: reader.read });
    console.log(JSON.stringify({ msg: "portal_read", ...report }));
  } finally {
    await pool.end();
  }
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (err: unknown) => {
    console.error(`portal read failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  },
);
