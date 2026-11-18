// The tracked directory listings, read from the graph (LC-SENSE-LISTING-BINDINGS).
//
// A listing is tracked through intake: propose_loop of a directory-listing loop
// whose event When is bound to the listings sensor with the listing's public
// page (source_binding.config = { subject, url }), then accept_loop, which arms
// it. The scheduled read targets exactly those bindings, never deploy
// configuration: armedListingTargets returns, for every active event When
// bound to the sensor's source that belongs to an armed (open, waiting or
// chased) directory-listing loop, its subject and public page URL. A proposed,
// suspended or closed loop, a loop of another type, or a When whose binding
// names no URL adds no target.
import { ARMED_LOOP_STATES } from "../kernel/kernel.ts";
import type { GraphStore, GraphTx } from "../kernel/store.ts";
import type { Loop } from "../kernel/types.ts";
import { publicPageUrl, type PublicListing } from "./public-listing.ts";
import { ANTHROPIC_LISTINGS_SENSOR } from "./sources.ts";

/** The loop type whose Whens the scheduled listings read reports (SPEC.md B2.3, directory-listing loops). */
export const DIRECTORY_LISTING_LOOP_TYPE = "directory-listing";

/**
 * The listings to read, in subject order. Throws when one subject is bound to
 * two different URLs, or a bound URL is not a public http(s) page, so the run
 * fails visibly rather than reading a guess.
 */
export async function armedListingTargets(
  store: GraphStore,
  source: string = ANTHROPIC_LISTINGS_SENSOR.source_binding.source,
): Promise<PublicListing[]> {
  return store.read(async (tx) => {
    const bySubject = new Map<string, string>();
    for (const loop of await tx.listLoops()) {
      if (loop.loop_type !== DIRECTORY_LISTING_LOOP_TYPE || !ARMED_LOOP_STATES.has(loop.state)) continue;
      for (const id of whenIds(loop)) {
        const target = await boundListing(tx, id, source);
        if (!target) continue;
        const seen = bySubject.get(target.subject);
        if (seen !== undefined && seen !== target.url)
          throw new Error(`listing ${target.subject} is bound to two pages: ${seen} and ${target.url}`);
        bySubject.set(target.subject, target.url);
      }
    }
    return [...bySubject].sort(([a], [b]) => a.localeCompare(b)).map(([subject, url]) => ({ subject, url }));
  });
}

/** The loop's member node ids and closing When id; non-When ids are dropped by boundListing. */
function whenIds(loop: Loop): string[] {
  const ids = [...loop.member_node_ids];
  if (loop.closing_when_id !== null && !ids.includes(loop.closing_when_id)) ids.push(loop.closing_when_id);
  return ids;
}

async function boundListing(tx: GraphTx, id: string, source: string): Promise<PublicListing | undefined> {
  const node = await tx.getNode(id);
  if (node?.kind !== "when" || node.status !== "active" || node.attributes["when_type"] !== "event") return undefined;
  const binding = node.attributes["source_binding"] as { source?: unknown; config?: Record<string, unknown> } | undefined;
  if (binding?.source !== source) return undefined;
  const subject = binding.config?.["subject"];
  const url = binding.config?.["url"];
  if (typeof subject !== "string" || subject.trim() === "" || url === undefined) return undefined;
  if (typeof url !== "string") throw new Error(`When ${id}: the page for listing ${subject} is not a string`);
  return { subject, url: publicPageUrl(subject, url) };
}
