# Registry pull credential

aks-obs-01 pulls the loopcloser image with loop-closer's own pull secret,
`loopcloser-registry-pull`. That Secret is never applied by hand: the
`loopcloser-registry-pull` ExternalSecret in `deploy/base/external-secrets.yaml`
(PR #45, LC-D1b-PULL) syncs it from OpenBao through the estate `openbao`
ClusterSecretStore and renders it as a `kubernetes.io/dockerconfigjson`
Secret. This page records where that credential lives in OpenBao and how it is
written (LC-D1b-PULL-CRED).

`tests/deploy/registry-pull-secret.test.ts` checks that the KV path and the
property names below are exactly the ones the ExternalSecret reads.

## Rule

Policy `policies/placement-defaults.yaml#credentials` (and
`registry-credential-per-product` v2):

- **Per product.** This credential is loop-closer's alone. It is never shared
  with another product and never reuses another product's path or token.
- **Pull-only.** A GHCR token with the `read:packages` scope only; no
  `write:packages`, `delete:packages` or repository scopes.
- **Under the product's path**, following the `kv/passband/ghcr-pull`
  pattern: `kv/<product>/registry-pull`, here `kv/loopcloser/registry-pull`.
- **Created by the DevOps route without an ask.** It is a pipeline credential.

## OpenBao

- **KV path:** `kv/loopcloser/registry-pull`
- **Store:** the estate `openbao` ClusterSecretStore (KV v2, mount `kv`).
- **Writer:** the delegated OpenBao ops AppRole (`delegated.openbao`, policy
  `decisions-expire-with-default`). No personal or root token is used.
- **Reader:** External Secrets Operator only, through the `openbao`
  ClusterSecretStore, into Secret `loopcloser-registry-pull` in namespace
  `loop-closer`.

## Properties

| Property | Holds |
| --- | --- |
| `registry` | Registry host the image is pulled from (`ghcr.io`); the key under `auths` in the rendered `.dockerconfigjson` |
| `username` | GitHub account that owns the pull-only token |
| `password` | The `read:packages` GHCR token |

The ExternalSecret reads each property by name; any other property at the path
is ignored, and a missing one leaves the Secret unsynced.

## Writing the credential

Run from the ops jump box, logged in as the delegated ops AppRole. The token is
never echoed, never passed as a command-line argument (which would land in
shell history and the process table) and never written to a file. The block
runs in a subshell so a failure aborts it without closing the operator's shell
and the AppRole token does not outlive it:

```sh
(
  # Log in as the delegated ops AppRole (policy decisions-expire-with-default).
  # BAO_ROLE_ID / BAO_SECRET_ID come from the delegated.openbao custody, not this repo.
  # Assign first, export after: `export VAR="$(...)"` masks a failed login and
  # would let bao fall back to the CLI's cached token-helper credential.
  BAO_TOKEN="$(bao write -field=token auth/approle/login \
    role_id="$BAO_ROLE_ID" secret_id="$BAO_SECRET_ID")" \
    || { echo 'AppRole login failed; nothing written' >&2; exit 1; }
  [ -n "$BAO_TOKEN" ] \
    || { echo 'AppRole login returned no token; nothing written' >&2; exit 1; }
  export BAO_TOKEN

  # GitHub account that owns the pull-only token.
  GHCR_PULL_USER='<github-user>'

  # Read the read:packages token without echo, then write it from stdin.
  read -rs GHCR_PULL_TOKEN
  printf '%s' "$GHCR_PULL_TOKEN" | bao kv put -mount=kv loopcloser/registry-pull \
    registry=ghcr.io username="$GHCR_PULL_USER" password=-
)
```

`password=-` makes `bao` read that property from stdin.

## Verifying

Without reading any secret value:

1. `bao kv metadata get -mount=kv loopcloser/registry-pull` shows a current
   version.
2. `bao kv get -mount=kv -format=json loopcloser/registry-pull | jq -r '.data.data | keys[]'`
   lists exactly `password`, `registry`, `username`.
3. In the cluster, the `loopcloser-registry-pull` ExternalSecret reports
   `Ready=True` / `SecretSynced` (`kubectl -n loop-closer get externalsecret
   loopcloser-registry-pull`). Do not read the synced Secret's data.
4. Rollout is estate-side GitOps; nothing is deployed by hand.

## Rotating

Write a new `read:packages` token with the same command; ESO picks it up
within the ExternalSecret's `refreshInterval` (1h). Then revoke the old token
on GitHub.
