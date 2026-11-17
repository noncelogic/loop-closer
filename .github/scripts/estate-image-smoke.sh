#!/usr/bin/env bash
# Smoke check of a built loopcloser estate image: runs a scheduled entrypoint's
# command in the image, as its CronJob would, and proves the entrypoint itself
# started. Used by ci.yml job `estate-image-dry-run`, the pull-request dry run
# of .github/workflows/estate-image.yml, and by test/deploy/estate-image.test.ts.
#
#   estate-image-smoke.sh IMAGE COMMAND [ARG...]
#   e.g. estate-image-smoke.sh loopcloser:sha-<commit> node dist/portal-read.js
#
# The container gets no network, no database and no credential, and runs with
# the CronJob's restrictions (uid 1000, read-only root, no capabilities).
# DATABASE_URL is deliberately unset, so a started portal-read entrypoint loads
# all of its modules and then exits 1 with its own message
# "portal read failed: Error: DATABASE_URL is not set". Anything else (a
# missing dist/ file, a module that fails to resolve, another exit code) fails
# the check.
set -uo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 IMAGE COMMAND [ARG...]" >&2
  exit 2
fi
image=$1
entrypoint=$2
shift 2

expected='portal read failed: Error: DATABASE_URL is not set'
output=$(docker run --rm --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  --env 'LISTINGS_DIRECTORY_PAGES={"rove-connector":"https://listings.example.invalid/rove-connector"}' \
  --entrypoint "$entrypoint" "$image" "$@" 2>&1)
status=$?
printf '%s\n' "$output"

if [ "$status" -ne 1 ] || ! grep -qF "$expected" <<<"$output"; then
  echo "::error::$image did not start '$entrypoint $*': exit $status, expected exit 1 with \"$expected\"" >&2
  exit 1
fi
echo "ok: $image starts '$entrypoint $*'"
