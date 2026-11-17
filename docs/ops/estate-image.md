# Estate image publish

`.github/workflows/estate-image.yml` runs on every merge to `main`. It builds
the loopcloser image on the estate's self-hosted runners (the `passband-ci` ARC
scale set) and pushes it to the estate registry that aks-obs-01 pulls from as
`loopcloser:sha-<commit>`, i.e.
`<ESTATE_REGISTRY>/loopcloser:sha-<full commit sha>`. The workflow never
touches a cluster: rollout is estate-side GitOps, pinning a `sha-<commit>` tag.

The registry push credential is per product (policy
`registry-credential-per-product` v2). It is custodied in OpenBao, provisioned
under LC-D1b-REGISTRY-CRED-DEC, and read by the job with its GitHub OIDC token.
It is never a GitHub secret.

This page lists configuration **by name only**. Values live in the repository
variables below and in OpenBao; credentials never go in this repository.
`tests/deploy/image-workflow.test.ts` checks that this page names exactly what
the workflow reads.

## Repository variables

Set under *Settings → Secrets and variables → Actions → Variables* on
`noncelogic/loop-closer`. These are configuration, not secrets. The job's first
step fails with `repository variable <NAME> is not set` if any of them is
empty.

| Variable | Read by | Holds |
| --- | --- | --- |
| `ESTATE_REGISTRY` | `docker/login-action`, `docker/build-push-action` | Registry host aks-obs-01 pulls from; the image is pushed as `<ESTATE_REGISTRY>/loopcloser:sha-<commit>` |
| `OPENBAO_ADDR` | `hashicorp/vault-action` (`url`) | OpenBao URL reachable from the `passband-ci` runners |
| `ESTATE_REGISTRY_OPENBAO_PATH` | `hashicorp/vault-action` (`secrets`) | OpenBao KV v2 API path of the push credential (`kv/data/<path>` form) |
| `ESTATE_REGISTRY_OPENBAO_ROLE` | `hashicorp/vault-action` (`role`) | OpenBao JWT role the job logs in as |

## OpenBao

- **Address:** `OPENBAO_ADDR`.
- **Auth method:** JWT (`method: jwt`), using the job's GitHub OIDC token
  (workflow permission `id-token: write`). No static token, AppRole or private
  key is used.
- **JWT role:** the role named by `ESTATE_REGISTRY_OPENBAO_ROLE`, as provisioned
  under LC-D1b-REGISTRY-CRED-DEC. Bind it to this repository's `main`-branch
  OIDC subject (`repo:noncelogic/loop-closer:ref:refs/heads/main`), and give it
  a policy that can only read the push-credential path.
- **KV path:** the KV v2 API path named by `ESTATE_REGISTRY_OPENBAO_PATH`, as
  provisioned under LC-D1b-REGISTRY-CRED-DEC. The workflow reads two fields
  there:
  - `username`: registry push username, read into step output `REGISTRY_USERNAME`
  - `password`: registry push password/token, read into step output `REGISTRY_PASSWORD`

  `exportEnv: false` keeps both out of later steps' environment. They reach
  only `docker/login-action`.

## Verifying a publish

1. Merge to `main`, then check that the `estate-image` run's `publish` job
   passes (`gh run list --workflow estate-image`).
2. If *Check estate registry configuration* fails, one of the variables above
   is unset.
3. If *Read the registry push credential from OpenBao* fails, the role's
   bound subject, its policy or the KV path does not match what this page
   describes.
4. Check that the registry has `loopcloser:sha-<commit>` for the merged commit.
