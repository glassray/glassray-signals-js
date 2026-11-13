import type { OtlpSpan, SignalsClient } from "../client.ts";
import type { SignalContext } from "../context.ts";
import { workItemString } from "./breadcrumbs.ts";

/*
 * Tool calls as spans (wrapMcpServer's toolCalls option). Each tool call becomes one OTLP span, sent
 * to /v1/traces with the signals key by the client's own queue. One agent session is one trace, with
 * a root span that carries who and what the session is about:
 *
 *   mcp session                      work_item, user.id, session.id, mcp.client.*, model, intent
 *     tools/call create_canvas      glassray.span.kind=tool, gen_ai.tool.name, error status
 *     tools/call apply_component
 *
 * The session is, in order: a session in the signal context, the MCP session id (Streamable HTTP's
 * Mcp-Session-Id), or one derived from user + work item + agent client that ends after 30 idle minutes
 * (stateless servers have no session id). Spans are written once on the server, so the root goes out
 * with the session's first call, and every tool span repeats the session's attributes: a model or
 * intent learned later in the session still reaches the dashboard.
 */

export type ToolCallsOptions = {
  /** A session without an MCP session id ends after this long without a call. Default 30 minutes. */
  idleMs?: number;
  /**
   * Adds two optional arguments to your tools' input schemas, so agents can say which model they run
   * as (llm_model) and what they are trying to do (intent). Your tool callbacks never see them.
   * Default true. Only tools with a raw-shape input schema get them.
   */
  selfReport?: boolean;
  /** service.name on every span. Defaults to the server's name. */
  serviceName?: string;
};

/** What the wrapper knows about one tool call, beyond the signal context. */
export type CallFacts = {
  tool: string;
  mcpSessionId?: string;
  client?: string;
  clientVersion?: string;
  protocolVersion?: string;
  model?: string;
  intent?: string;
  serviceName?: string;
  /* one per wrapped server: the session of last resort, when nothing says who is calling */
  connection?: string;
};

type Session = {
  key: string;
  traceId: string;
  rootSpanId: string;
  id: string;
  lastAt: number;
  /* the root span goes out with the session's first recorded tool call */
  rootSent: boolean;
  model?: string;
  intent?: string;
};

export const DEFAULT_IDLE_MS = 30 * 60_000;
const MAX_SESSIONS = 5000;
const sessions = new Map<string, Session>();

/* Node 18 has no global crypto without a flag; ids only need to be unlikely to collide */
export const hex = (bytes: number) => {
  const b = new Uint8Array(bytes);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < bytes; i++) b[i] = Math.floor(Math.random() * 256);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};
const nano = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;

/**
 * The session this call belongs to: found, or started. Any session ends after an idle gap; a named one
 * (context or MCP session id) then keeps its id but starts a new trace, so no trace lasts for days.
 */
export function sessionFor(ctx: SignalContext, facts: CallFacts, now: number, idleMs = DEFAULT_IDLE_MS): Session {
  const explicit = ctx.session ?? facts.mcpSessionId;
  const work = workItemString(ctx.workItem);
  /* nothing says who is calling: group by connection, not by client, or every caller of one client would merge */
  const who = ctx.user || work ? `${ctx.user ?? ""}|${work ?? ""}` : `conn:${facts.connection ?? ""}`;
  const key = explicit ? `s|${explicit}` : `d|${who}|${facts.client ?? ctx.agent?.client ?? ""}`;
  const found = sessions.get(key);
  if (found && now - found.lastAt < idleMs) {
    found.lastAt = now;
    sessions.delete(key);
    sessions.set(key, found);
    return found;
  }
  const traceId = hex(16);
  const session: Session = { key, traceId, rootSpanId: hex(8), id: explicit ?? `mcp-${traceId.slice(0, 16)}`, lastAt: now, rootSent: false };
  sessions.set(key, session);
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  return session;
}

/** For tests. */
export function resetToolCallSessions(): void {
  sessions.clear();
}

type Attr = OtlpSpan["attributes"][number];
const attrs = (o: Record<string, string | undefined>): Attr[] =>
  Object.entries(o)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== "")
    .map(([key, v]) => ({ key, value: { stringValue: v } }));

/** Attributes every span of a session carries, so they reach the dashboard from any span. */
function sessionAttrs(s: Session, ctx: SignalContext, f: CallFacts): Record<string, string | undefined> {
  return {
    "service.name": f.serviceName,
    work_item: workItemString(ctx.workItem),
    "user.id": ctx.user,
    "session.id": s.id,
    "mcp.session.id": f.mcpSessionId,
    "mcp.client.name": f.client ?? ctx.agent?.client,
    "mcp.client.version": f.clientVersion,
    "mcp.protocol.version": f.protocolVersion,
    "gen_ai.request.model": s.model,
    "mcp.intent": s.intent,
  };
}

/**
 * Records one finished tool call: the session's root span if this call started it, and the tool span.
 * Never throws.
 */
export function recordToolCall(
  client: SignalsClient,
  call: { session: Session; ctx: SignalContext; facts: CallFacts; start: number; end: number; error?: string },
): void {
  try {
    const { session: s, ctx, facts: f } = call;
    if (f.model) s.model = f.model;
    if (f.intent && !s.intent) s.intent = f.intent;
    const shared = sessionAttrs(s, ctx, f);
    if (!s.rootSent) {
      s.rootSent = true;
      client._span({
        traceId: s.traceId,
        spanId: s.rootSpanId,
        name: "mcp session",
        kind: 2,
        startTimeUnixNano: nano(call.start),
        endTimeUnixNano: nano(call.start),
        attributes: attrs({ ...shared, "glassray.span.kind": "session" }),
      });
    }
    client._span({
      traceId: s.traceId,
      spanId: hex(8),
      parentSpanId: s.rootSpanId,
      name: `tools/call ${f.tool}`,
      kind: 2,
      startTimeUnixNano: nano(call.start),
      endTimeUnixNano: nano(call.end),
      attributes: attrs({
        ...shared,
        /* this call's own intent, when the agent gave one */
        ...(f.intent ? { "mcp.intent": f.intent } : {}),
        "glassray.span.kind": "tool",
        "gen_ai.tool.name": f.tool,
        "gen_ai.operation.name": "execute_tool",
        "mcp.method.name": "tools/call",
        ...(call.error !== undefined ? { "error.type": "tool_error" } : {}),
      }),
      status: call.error !== undefined ? { code: 2, message: call.error } : { code: 1 },
    });
  } catch {
    /* tracing must never break the tool */
  }
}

/* ---------- self-reported model and intent ---------- */

export const MODEL_ARG = "llm_model";
export const INTENT_ARG = "intent";
const MODEL_DESCRIPTION = "Optional. The model you are running as, e.g. claude-opus-4-5. Helps the makers of this tool see how it works across models.";
const INTENT_DESCRIPTION = "Optional. In a few words, what you are trying to do with this call, e.g. 'add a pricing section'.";

type ZodLike = { optional(): ZodLike; describe(d: string): ZodLike; max?(n: number): ZodLike };
type ZodModule = { string(): ZodLike };

const isZodSchema = (v: unknown) => typeof v === "object" && v !== null && ("_def" in v || "_zod" in v);

/**
 * Adds llm_model and intent to a raw-shape input schema, using the caller's zod. Returns the new
 * shape and the names it added, or null when it cannot do so safely (a full zod object, a mix of zod
 * versions, or no zod at all).
 */
export function withSelfReportArgs(shape: unknown, z: ZodModule | undefined): { shape: Record<string, unknown>; added: string[] } | null {
  try {
    if (!z || typeof shape !== "object" || shape === null || isZodSchema(shape)) return null;
    const own = shape as Record<string, unknown>;
    const ours = z.string();
    const first = Object.values(own)[0];
    /* the SDK cannot mix zod 3 and zod 4 in one shape */
    if (first !== undefined && (!isZodSchema(first) || "_zod" in (first as object) !== "_zod" in (ours as object))) return null;
    const added: string[] = [];
    const next = { ...own };
    if (!(MODEL_ARG in own)) {
      next[MODEL_ARG] = z.string().optional().describe(MODEL_DESCRIPTION);
      added.push(MODEL_ARG);
    }
    if (!(INTENT_ARG in own)) {
      next[INTENT_ARG] = z.string().optional().describe(INTENT_DESCRIPTION);
      added.push(INTENT_ARG);
    }
    return { shape: next, added };
  } catch {
    return null;
  }
}

const str = (v: unknown, max = 200) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** A model in the request's _meta, for clients that send one there. */
export function modelFromMeta(meta: unknown): string | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const m = meta as Record<string, unknown>;
  return str(m["gen_ai.request.model"]) ?? str(m[MODEL_ARG]) ?? str(m.model);
}

export const cleanArg = str;
