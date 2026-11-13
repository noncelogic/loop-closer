// Calendar When schedules (SPEC B2.1): a one-off datetime or a recurrence rule,
// evaluated in the When's IANA timezone so a "09:00 every Monday" stays 09:00
// local across DST changes.
//
// Supported RRULE subset (RFC 5545): FREQ=MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY,
// INTERVAL, BYDAY (WEEKLY only, INTERVAL=1), UNTIL. Anything else is rejected
// rather than silently mis-scheduled.
//
// DAILY/WEEKLY/MONTHLY occurrences are computed from the rule's anchor — its
// `dtstart` read in the When's timezone — not from the previous firing
// instant: the time of day (and MONTHLY's day of month) always come from the
// anchor, so an occurrence pushed forward by a DST gap (02:30 -> 03:30) does
// not shift every later one. Without a `dtstart` the fired occurrence is the
// only anchor available.

export type CalendarSchedule = { readonly at: string } | { readonly rrule: string; readonly dtstart?: string };

export interface NextFire {
  /** Next occurrence strictly after `now`; null when the schedule is exhausted. */
  readonly next: Date | null;
  /** Occurrences after the one being fired that were already due at `now` (missed ticks) and are skipped. */
  readonly missed: number;
}

export class ScheduleError extends Error {
  override name = "ScheduleError";
}

const MAX_STEPS = 100_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

interface Rule {
  freq: "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  byDay: Set<number> | null;
  until: Date | null;
}

export function parseRrule(rrule: string): Rule {
  const parts = new Map<string, string>();
  for (const part of rrule.replace(/^RRULE:/, "").split(";")) {
    const [k, v] = part.split("=");
    if (!k || v === undefined) throw new ScheduleError(`malformed RRULE part ${JSON.stringify(part)}`);
    parts.set(k.toUpperCase(), v.toUpperCase());
  }
  const freq = parts.get("FREQ");
  if (freq !== "MINUTELY" && freq !== "HOURLY" && freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") {
    throw new ScheduleError(`unsupported RRULE FREQ ${JSON.stringify(freq)}`);
  }
  const interval = Number(parts.get("INTERVAL") ?? "1");
  if (!Number.isInteger(interval) || interval < 1) throw new ScheduleError(`invalid RRULE INTERVAL ${parts.get("INTERVAL")}`);
  let byDay: Set<number> | null = null;
  const bd = parts.get("BYDAY");
  if (bd !== undefined) {
    if (freq !== "WEEKLY" || interval !== 1) throw new ScheduleError("RRULE BYDAY is supported only with FREQ=WEEKLY;INTERVAL=1");
    byDay = new Set(
      bd.split(",").map((d) => {
        const i = WEEKDAYS.indexOf(d as (typeof WEEKDAYS)[number]);
        if (i < 0) throw new ScheduleError(`invalid RRULE BYDAY value ${JSON.stringify(d)}`);
        return i;
      }),
    );
  }
  let until: Date | null = null;
  const u = parts.get("UNTIL");
  if (u !== undefined) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(u);
    if (!m) throw new ScheduleError(`invalid RRULE UNTIL ${JSON.stringify(u)}`);
    until = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 23), +(m[5] ?? 59), +(m[6] ?? 59)));
  }
  for (const k of parts.keys()) {
    if (!["FREQ", "INTERVAL", "BYDAY", "UNTIL"].includes(k)) throw new ScheduleError(`unsupported RRULE part ${k}`);
  }
  return { freq, interval, byDay, until };
}

interface Local {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
  s: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      throw new ScheduleError(`unknown timezone ${JSON.stringify(timeZone)}`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

function toLocal(date: Date, timeZone: string): Local {
  const p: Record<string, number> = {};
  for (const { type, value } of formatter(timeZone).formatToParts(date)) p[type] = Number(value);
  return { y: p["year"]!, mo: p["month"]!, d: p["day"]!, h: p["hour"]!, mi: p["minute"]!, s: p["second"]! };
}

function localAsUtcMs(l: Local): number {
  return Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s);
}

/** The instant at which the wall clock in `timeZone` reads `l` (a skipped DST-gap time resolves forward). */
function fromLocal(l: Local, timeZone: string): Date {
  const target = localAsUtcMs(l);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const offset = localAsUtcMs(toLocal(new Date(guess), timeZone)) - guess;
    const next = target - offset;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

/** Local calendar date shifted by whole days/months, keeping the time of day. */
function shiftLocal(l: Local, days: number, months = 0): Local {
  const t = new Date(Date.UTC(l.y, l.mo - 1 + months, l.d + days));
  return { ...l, y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function weekday(l: Local): number {
  return new Date(Date.UTC(l.y, l.mo - 1, l.d)).getUTCDay();
}

/** `prev`'s local calendar date carrying the anchor's wall-clock time of day. */
function anchoredLocal(prev: Date, timeZone: string, anchor: Local): Local {
  return { ...toLocal(prev, timeZone), h: anchor.h, mi: anchor.mi, s: anchor.s };
}

function step(rule: Rule, prev: Date, timeZone: string, anchor: Local): Date {
  switch (rule.freq) {
    case "MINUTELY":
      return new Date(prev.getTime() + rule.interval * 60_000);
    case "HOURLY":
      return new Date(prev.getTime() + rule.interval * 3_600_000);
    case "DAILY":
      return fromLocal(shiftLocal(anchoredLocal(prev, timeZone, anchor), rule.interval), timeZone);
    case "WEEKLY": {
      const local = anchoredLocal(prev, timeZone, anchor);
      if (!rule.byDay) return fromLocal(shiftLocal(local, 7 * rule.interval), timeZone);
      for (let i = 1; i <= 7; i++) {
        const cand = shiftLocal(local, i);
        if (rule.byDay.has(weekday(cand))) return fromLocal(cand, timeZone);
      }
      throw new ScheduleError("RRULE BYDAY is empty");
    }
    case "MONTHLY": {
      // Months lacking the anchor day are skipped (RFC 5545), so walk from the anchor.
      const anchorDay = anchor.d;
      const local = anchoredLocal(prev, timeZone, anchor);
      for (let k = rule.interval; k <= rule.interval * 48; k += rule.interval) {
        const cand = shiftLocal({ ...local, d: 1 }, 0, k);
        const daysInMonth = new Date(Date.UTC(cand.y, cand.mo, 0)).getUTCDate();
        if (anchorDay <= daysInMonth) return fromLocal({ ...cand, d: anchorDay }, timeZone);
      }
      throw new ScheduleError(`no month has day ${anchorDay}`);
    }
  }
}

/**
 * Next fire time after firing the occurrence scheduled at `fired`, given the
 * tick is running at `now`. Missed occurrences (ticks that never ran) are not
 * replayed: the When fires once and advances to its next future occurrence.
 */
export function nextFireAt(schedule: CalendarSchedule, timeZone: string, fired: Date, now: Date): NextFire {
  formatter(timeZone); // validate the timezone even for one-off schedules
  if ("at" in schedule) return { next: null, missed: 0 };
  const rule = parseRrule(schedule.rrule);
  const anchor = toLocal(schedule.dtstart !== undefined ? new Date(schedule.dtstart) : fired, timeZone);
  let missed = 0;
  let next = step(rule, fired, timeZone, anchor);
  if (rule.freq === "MINUTELY" || rule.freq === "HOURLY") {
    // Fixed-length steps: skip the backlog arithmetically rather than one by one.
    const len = next.getTime() - fired.getTime();
    if (next.getTime() <= now.getTime()) {
      const k = Math.floor((now.getTime() - next.getTime()) / len) + 1;
      missed = k;
      next = new Date(next.getTime() + k * len);
    }
  } else {
    for (let i = 0; next.getTime() <= now.getTime(); i++) {
      if (i >= MAX_STEPS) throw new ScheduleError("schedule backlog too large to advance");
      missed++;
      next = step(rule, next, timeZone, anchor);
    }
  }
  if (rule.until && next.getTime() > rule.until.getTime()) return { next: null, missed };
  return { next, missed };
}

export function parseSchedule(value: unknown): CalendarSchedule {
  if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    if (typeof v["at"] === "string" && !Number.isNaN(Date.parse(v["at"]))) return { at: v["at"] };
    if (typeof v["rrule"] === "string") {
      const dtstart = v["dtstart"];
      if (dtstart === undefined) return { rrule: v["rrule"] };
      if (typeof dtstart === "string" && !Number.isNaN(Date.parse(dtstart))) return { rrule: v["rrule"], dtstart };
    }
  }
  throw new ScheduleError(`invalid calendar schedule ${JSON.stringify(value)}`);
}
