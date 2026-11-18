# Estate image publish

`.github/workflows/estate-image.yml` runs on every merge to `main`. It builds
the loopcloser image on a GitHub-hosted runner (`ubuntu-latest`, as `ci` does)
and pushes it to the estate registry that aks-obs-01 pulls from as
`loopcloser:sha-<commit>`, i.e.
`<ESTATE_REGISTRY>/loopcloser:sha-<full commit sha>`. The workflow never
touches a cluster: rollout is estate-side GitOps, pinning a `sha-<commit>` tag.

It used to target the estate's `passband-ci` self-hosted runners, but those
are registered only for `noncelogic/loopmentum`, so no run ever started
(LC-ESTATE-IMAGE-RUNNER). The `estate-image` concurrency group still
serialises pushes, without cancelling a run in progress.

The registry push credential is loop-closer's own, least privilege (push to
`loopcloser` only), per product (policy `registry-credential-per-product`),
custodied in OpenBao at `kv/loop-closer/registry-push` and created by the
DevOps route (Rule: policies/placement-defaults.yaml#credentials). The job
never reads repository secrets: `.github/scripts/estate-registry-credential.mjs`
mints the job's GitHub OIDC token, logs in to OpenBao through JWT auth and
pipes the password to `docker login --password-stdin` (LC-EST-IMAGE-PUBLISH).

This page lists configuration **by name only**. Values live in the repository
variables and in OpenBao; credentials never go in this repository.
`tests/deploy/image-workflow.test.ts` checks that this page names exactly what
the workflow reads.

## Repository variables

Set under *Settings → Secrets and variables → Actions → Variables* on
`noncelogic/loop-closer`. These are configuration, not secrets. The login step
fails with `repository variable <NAME> is not set` if any of them is empty.

| Variable | Read by | Holds |
| --- | --- | --- |
| `ESTATE_REGISTRY` | `estate-registry-credential.mjs`, `docker/build-push-action` | Registry host aks-obs-01 pulls from; the image is pushed as `<ESTATE_REGISTRY>/loopcloser:sha-<commit>` |
| `OPENBAO_ADDR` | `estate-registry-credential.mjs` | Estate OpenBao address the runner reaches (`https://…`, no trailing path) |

## OpenBao push credential

- **KV path:** `kv/loop-closer/registry-push` (KV v2, mount `kv`).
- **Properties:** `username` and `password` (a token that can push
  `loopcloser` to `ESTATE_REGISTRY` and nothing else). Other properties are
  ignored.
- **Auth:** JWT auth mount `jwt`, bound audience `openbao`, GitHub Actions
  OIDC issuer `https://token.actions.githubusercontent.com`.
  - Role `loop-closer-registry-push`: bound to
    `repo:noncelogic/loop-closer:ref:refs/heads/main`; policy grants `read`
    on `kv/data/loop-closer/registry-push` only. Used by the `publish` job.
  - Role `loop-closer-registry-push-check`: bound to repository
    `noncelogic/loop-closer` (pull requests included); policy grants `read`
    on `kv/metadata/loop-closer/registry-push` only, so the dry run proves
    the credential exists without ever reading it.
- **Writer:** the DevOps route, through the delegated OpenBao ops AppRole, as
  for `kv/loopcloser/registry-pull` (docs/ops/registry-pull.md).

If the login fails, the step's error names the input:
`OpenBao push credential kv/loop-closer/registry-push is unreachable: <why>`.

## Pull-request dry run

The publish acts only on `main`, so every pull request proves it first: the
`ci` workflow's `estate-image-dry-run` job builds the same context and
Dockerfile on a GitHub-hosted runner, tags it `loopcloser:sha-<commit>`
without a registry, pushes nothing, and runs the listings-read CronJob's
command (`node dist/portal-read.js`) in the built image through
`.github/scripts/estate-image-smoke.sh`. It reads no secret and no repository
variable. `test/deploy/estate-image.test.ts` checks the job and runs the same
build and smoke check.

The `ci` workflow's `estate-image-inputs` job dry-runs the registry inputs:
it runs `estate-registry-credential.mjs check` with the same variables, logs in
to OpenBao as `loop-closer-registry-push-check` and checks
`kv/loop-closer/registry-push` has a current version. It reads no secret and
never the credential itself, and fails naming the missing input
(`ESTATE_REGISTRY`, `OPENBAO_ADDR`, the OIDC token or the credential).
`tests/ci/estate-image-workflow.test.ts` runs the script against a local
stand-in for OpenBao.

## Verifying a publish

1. Merge to `main`, then check that the `estate-image` run's `publish` job
   passes (`gh run list --workflow estate-image`).
2. If *Log in to the estate registry with the OpenBao push credential* fails,
   its error names the unset variable or the unreachable OpenBao input.
3. If `docker login` or the push fails, `kv/loop-closer/registry-push` does
   not hold a credential that can push `loopcloser` to `ESTATE_REGISTRY`.
4. Check that the registry has `loopcloser:sha-<commit>` for the merged commit.
