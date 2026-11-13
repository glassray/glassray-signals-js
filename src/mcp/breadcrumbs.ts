import type { SignalsClient } from "../client.ts";
import { getContext, type SignalContext } from "../context.ts";
import type { SignalInput, WorkItem } from "../types.ts";

/*
 * Breadcrumbs: the last tool calls, kept per user and work item (MCP servers are often stateless, a new
 * server per request, so per connection would not work). Signals from agents carry the last few, so a
 * report arrives with the calls that led to it.
 */

export type Crumb = { tool: string; ok: boolean; ms: number; error?: string; trace?: string; at: number };

const CRUMB_TTL_MS = 30 * 60_000;
const CRUMBS_PER_KEY = 10;
export const MAX_KEYS = 5000;
const crumbs = new Map<string, Crumb[]>();

/** A work item as one string: "canvas:c1" for a typed id. */
export const workItemString = (w: WorkItem | undefined) => (w === undefined ? undefined : typeof w === "string" ? w : `${w.type}:${w.id}`);

export function keyOf(ctx: SignalContext): string | null {
  const work = workItemString(ctx.workItem) ?? "";
  if (!ctx.user && !work && !ctx.session) return null;
  return `${ctx.user ?? ""}|${work}|${ctx.session ?? ""}`;
}

/* also kept per user alone: a report often names no work item, but comes from the same person's session */
const userKey = (ctx: SignalContext) => (ctx.user ? `${ctx.user}||` : null);

export function remember(ctx: SignalContext, crumb: Crumb) {
  for (const key of new Set([keyOf(ctx), userKey(ctx)])) {
    if (!key) continue;
    const list = (crumbs.get(key) ?? []).filter((c) => crumb.at - c.at < CRUMB_TTL_MS);
    list.push(crumb);
    crumbs.delete(key);
    crumbs.set(key, list.slice(-CRUMBS_PER_KEY));
    if (crumbs.size > MAX_KEYS) crumbs.delete(crumbs.keys().next().value!);
  }
}

/** Recent tool calls for this context, newest last: for its work item if any were recorded, else for its user. */
export function recentToolCalls(ctx: SignalContext = getContext()): Crumb[] {
  const fresh = (key: string | null) => (key ? (crumbs.get(key) ?? []).filter((c) => Date.now() - c.at < CRUMB_TTL_MS) : []);
  const exact = fresh(keyOf(ctx));
  return exact.length ? exact : fresh(userKey(ctx));
}

/** For tests. */
export function resetBreadcrumbs(): void {
  crumbs.clear();
}

const enriched = new WeakSet<SignalsClient>();

/** Signals from agents carry the last tool calls, and link to the trace of the last one that failed. */
export function addBreadcrumbs(client: SignalsClient) {
  if (enriched.has(client)) return;
  enriched.add(client);
  client.addEnricher((s: SignalInput, ctx) => {
    if (s.source !== "agent") return s;
    const recent = recentToolCalls(ctx).slice(-5);
    if (recent.length === 0) return s;
    const failed = [...recent].reverse().find((c) => !c.ok);
    const trace = s.refs?.trace ?? failed?.trace ?? recent[recent.length - 1]?.trace;
    return {
      ...s,
      ...(trace ? { refs: { ...s.refs, trace } } : {}),
      context: {
        ...s.context,
        recent_tool_calls: recent.map((c) => ({
          tool: c.tool,
          ok: c.ok,
          ms: c.ms,
          ...(c.error ? { error: c.error } : {}),
          at: new Date(c.at).toISOString(),
        })),
      },
    };
  });
}
