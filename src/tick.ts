// The timer tick entrypoint: `node dist/tick.js` (deploy/base/tick-cronjob.yaml).
//
// Runs one runTick against PgTimerStore at DATABASE_URL, prints the report as
// one JSON line, closes the pool and exits. Any failure — no DATABASE_URL, an
// unreachable database, a rolled-back tick — exits non-zero so the CronJob's
// Job fails visibly.
import { randomUUID } from "node:crypto";
import { CONFIG_ENV } from "./config.ts";
import { PgTimerStore } from "./timer/pg-store.ts";
import { runTick } from "./timer/tick.ts";

async function main(): Promise<void> {
  const databaseUrl = process.env[CONFIG_ENV.databaseUrl];
  if (!databaseUrl) throw new Error(`${CONFIG_ENV.databaseUrl} is not set`);

  const store = new PgTimerStore({ connectionString: databaseUrl });
  try {
    const report = await runTick(store, { now: new Date(), newId: () => `lc_evt_${randomUUID()}` });
    console.log(JSON.stringify({ msg: "tick", ...report }));
  } finally {
    await store.close();
  }
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (err: unknown) => {
    console.error(`tick failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exitCode = 1;
  },
);
