# Vision — Loop Closer (working title)

Loop Closer maintains a live graph of **who**, **what**, and **when** — where
a *who* can be a person or a thing, a *what* can be an action or a thing, and
a *when* can be an event firing or a calendar event — related causally or
otherwise, and drives open loops closed. In the owner's words: it **tracks
who, what, when**.

## The problem it solves

Anyone who works with an AI agent over months accumulates two kinds of state
that actually matter:

1. **Open loops** — who owes what, to whom, since when, waiting on which
   event.
2. **A ranked corpus** — the material you have gathered, with its relevance
   made explicit (that is the sister project,
   [Corpus Ranker](https://github.com/noncelogic/corpus-ranker)).

That state is your life being run: the follow-up that must go out, the
review you are silently waiting on, the deadline that fires a preparation
workflow. In a vendor's harness it exists, if at all, as prose in a chat —
unexportable and gone when you switch. Loop Closer exists so open loops are
**owned data**: an explicit graph of nodes, causal edges, and triggers,
stored outside any harness, in exportable form, on the owner's own
infrastructure. AI harnesses (any vendor's, and the owner's own agents) are
replaceable readers and executors. Switching harness means re-pointing, not
migrating.

## What it is

- A personal loop-tracking system, **internal-first**: built for the owner's
  own loops and dogfooded on them — research follow-through, outreach,
  objective tracking, accountability, errands with external counterparties,
  and more.
- Live and consistency-critical. State transitions are exact and
  transactional, never similarity-based: a loop transition lost or
  double-applied means someone is chased twice, or never. That failure is
  what this system exists to prevent.
- Driven by a timer loop and sensors: calendar moments and external events
  fire the next step; a loop that is ageing in silence is surfaced, not
  forgotten.
- Conservative by default. Loops are proposed, then accepted — commitments do
  not appear from nowhere. External sends are not autonomous: they run under
  a per-loop-type authority policy that defaults to the owner approving each
  send.

## What it is not

- Not a to-do list, a calendar, or a CRM. Those hold fragments; this holds
  the causal graph of what is open, who owes what, and what event closes it.
- Not a hosted product. Whether this is ever offered to anyone else is a
  separate decision that has **not** been made. This repository is public for
  transparency, not as a product launch.
- Not tied to any model or harness vendor, by design.

## Status and rights

This project is under active design and early build by its owner. **No
license has been granted** for the contents of this repository; all rights
are reserved. See [CONTRIBUTING.md](CONTRIBUTING.md) for the current terms
under which issues and pull requests are handled, and
[INTENDED-USE.md](INTENDED-USE.md) for the owner's governing statement of
what this system is for.
