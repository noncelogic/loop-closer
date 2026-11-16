// Test-only preload (`node --import`): freezes the wall clock at FROZEN_NOW so
// a child process and the test that asserts on its output share one instant.
// `new Date()` and `Date.now()` return FROZEN_NOW; `new Date(x)` is unchanged.
const frozen = Date.parse(process.env.FROZEN_NOW ?? "");
if (Number.isNaN(frozen)) throw new Error("frozen-clock: FROZEN_NOW must be an ISO timestamp");

globalThis.Date = class FrozenDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(frozen);
    else super(...args);
  }
  static now() {
    return frozen;
  }
};
