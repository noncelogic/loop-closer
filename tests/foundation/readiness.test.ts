import { test } from "node:test";
import assert from "node:assert/strict";
import { readinessPort } from "./readiness.ts";

const LINE = "loopcloser listening on http://127.0.0.1:43210\n";

test("readiness port is only reported once its line is newline-terminated", () => {
  // Feed the readiness line split at every possible chunk boundary.
  for (let cut = 0; cut < LINE.length; cut++) {
    let buffered = LINE.slice(0, cut);
    assert.equal(readinessPort(buffered), undefined, `partial line ${JSON.stringify(buffered)}`);
    buffered += LINE.slice(cut);
    assert.equal(readinessPort(buffered), 43210);
  }
});

test("readiness port ignores unrelated lines and handles CRLF", () => {
  assert.equal(readinessPort("booting\nloopcloser listening on http://127.0.0.1:5\r\n"), 5);
  assert.equal(readinessPort("booting\n"), undefined);
});
