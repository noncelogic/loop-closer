# Loop Closer (working title — name not final)

Joe Graham's personal loop-tracking system: it maintains a live, supersedable graph of who, what, and when — a who can be a person or a thing, a what an action or a thing, a when an event firing or a calendar event — related causally or otherwise, and drives open loops closed. In Joe's words, it "tracks who, what, when."

Internal-first: built for Joe's own loops and dogfooded on them. Externalisation is undecided — a premise-class decision that has not been made.

Documents in this folder:
- `INTENDED-USE.md` — founder-approved intended use (Joe Graham, 2026-11-07)
- `DEFINITIONS.md` — governing refined definitions (shared document, also filed under `projects/corpus-ranker/`)
- `SPEC.md` — buildable spec (covers both Corpus Ranker and Loop Closer)
- `TECH-STACK.md` — the decided tech stack (2026-11-07)

Project record: the canonical charter, spec, and plan for this project live in the meta-harness `projects/loop-closer/` folder; this repository is its code home.

## Development

Requires Node.js 24+ and Docker with the Compose plugin.

```sh
npm ci              # install (TypeScript toolchain only)
npm run typecheck   # tsc over src/ and tests/
npm run build       # emit dist/ — the loopcloser service skeleton
npm test            # node:test suite, including the Compose replica test
npm run replica:up  # one-command local replica: Postgres 17 + pgvector, `loopcloser` database
```

`compose.yaml` is the local replica of the deployment shape (TECH-STACK.md §2/§3). It binds
Postgres to `127.0.0.1:${LOOPCLOSER_PG_PORT:-5432}`; the credentials in it are local-only.

<<<<<<< HEAD
The loop model's Postgres schema is versioned SQL in `db/migrations/` (`NNNN_name.sql`, applied
once each, in order, recorded in `schema_migrations`). The service connects as the
`loopcloser_app` role, which can append to and read `ledger_events` but cannot update or delete
them. `tests/schema/` proves the schema on a fresh Compose replica.
=======
## Deployment

`Dockerfile` builds the service image; CI (job `image`) publishes it to
`ghcr.io/noncelogic/loop-closer` on pushes to `main`. `deploy/` holds the kustomize
package for aks-obs-01 (namespace `loop-closer`, CNPG cluster `loopcloser-db`, API
Deployment/Service, suspended per-minute tick CronJob, OpenBao ExternalSecrets). Nothing in
this repo applies it to a cluster; rollout is estate-side GitOps. There is no public ingress.
`tests/deploy/manifests.test.ts` renders it with `kustomize` (or `kubectl kustomize`).
>>>>>>> origin/main
