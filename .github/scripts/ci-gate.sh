#!/usr/bin/env bash
# The decision of ci.yml's result job `gate`, main's one required status check
# (policy main-stays-green, COND-277). The job passes the results of every job
# it needs, and this exits 0 only when there is at least one result and every
# one is `success`; any other result (failure, cancelled, skipped, or anything
# GitHub adds later) fails the check. Run by tests/ci/required-gate.test.ts
# through the workflow step's own command.
#
#   ci-gate.sh RESULT [RESULT...]
#   e.g. ci-gate.sh success success failure
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "gate: no needed job results given" >&2
  exit 1
fi

failed=0
for result in "$@"; do
  if [ "$result" != "success" ]; then
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "gate: a needed ci job did not succeed (results: $*)" >&2
  exit 1
fi
echo "gate: every needed ci job succeeded (results: $*)"
