import { getContext, type SignalContext } from "./context.ts";
import type { SignalInput } from "./types.ts";

export type SignalsOptions = {
  /** An API key from Glassray Settings (gr_...). Defaults to the GLASSRAY_API_KEY environment variable. */
  apiKey?: string;
  /** Glassray origin. Defaults to GLASSRAY_ENDPOINT, then https://app.glassray.ai. */
  endpoint?: string;
  /** Turn sending off without removing calls. Default: on when there is a valid key. */
  enabled?: boolean;
  /** Edit or drop (return null) each signal before it is queued. Runs after context is filled in. */
  beforeSend?: (signal: SignalInput) => SignalInput | null;
  /** 0 to 1: the share of signals kept. Default 1. */
  sampleRate?: number;
  /** Called when sending fails. Defaults to one console.warn per minute. Pass () => {} for silence. Never throws into your code. */
  onError?: (err: Error) => void;
  /** Signals held while Glassray is unreachable. Beyond this, new signals are dropped. Default 2000. */
  maxQueue?: number;
  /**
   * Edit or drop (return null) each span before it is queued (wrapMcpServer's toolCalls option). Spans
   * carry user.id, work_item and the agent's own words in mcp.intent: scrub them here as in beforeSend.
   */
  beforeSendSpan?: (span: OtlpSpan) => OtlpSpan | null;
  /** Custom fetch, e.g. for tests. Defaults to the global fetch at send time. */
  fetch?: typeof fetch;
};

/** Adds fields to a signal from somewhere other than the context (the MCP wrapper adds recent tool calls). */
export type Enricher = (signal: SignalInput, ctx: SignalContext) => SignalInput;

/** One span in OTLP/HTTP JSON encoding, as /v1/traces reads it. */
export type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }[];
  status?: { code: number; message?: string };
};

/* works outside Node too (edge runtimes, browsers): no hard dependency on process */
const env = (k: string) => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[k];

const FLUSH_MS = 1000;
const BATCH = 200;

/** Fills a signal from the context. Explicit fields always win. */
export function applyContext(s: SignalInput, ctx: SignalContext): SignalInput {
  const refs = {
    ...(ctx.user ? { user: ctx.user } : {}),
    ...(ctx.session ? { session: ctx.session } : {}),
    ...(ctx.trace ? { trace: ctx.trace } : {}),
    ...(ctx.run ? { run: ctx.run } : {}),
    ...s.refs,
  };
  const agent = { ...ctx.agent, ...s.agent };
  const context = { ...ctx.extra, ...s.context };
  return {
    ...s,
    ...(s.work_item === undefined && ctx.workItem !== undefined ? { work_item: ctx.workItem } : {}),
    ...(Object.keys(refs).length ? { refs } : {}),
    ...(Object.keys(agent).length ? { agent } : {}),
    ...(Object.keys(context).length ? { context } : {}),
  };
}

/**
 * Sends signals to Glassray in the background. Calls return at once and never throw:
 * a Glassray outage must never break the product that uses it. Signals are batched every second.
 * Most code uses the module functions (init, signal) instead of creating clients.
 */
export class SignalsClient {
  readonly enabled: boolean;
  private readonly url: string;
  private readonly tracesUrl: string;
  private readonly key: string;
  private readonly opts: SignalsOptions;
  private readonly enrichers: Enricher[] = [];
  private queue: SignalInput[] = [];
  private spans: OtlpSpan[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> = Promise.resolve();
  private lastWarn = 0;

  constructor(opts: SignalsOptions = {}) {
    this.opts = opts;
    this.key = opts.apiKey ?? env("GLASSRAY_API_KEY") ?? "";
    const base = (opts.endpoint ?? env("GLASSRAY_ENDPOINT") ?? "https://app.glassray.ai").replace(/\/+$/, "");
    this.url = base.endsWith("/v1/signals") ? base : `${base}/v1/signals`;
    this.tracesUrl = `${this.url.slice(0, -"/v1/signals".length)}/v1/traces`;
    this.enabled = (opts.enabled ?? true) && this.key.startsWith("gr_");
    /* no key: quietly off, as documented. A key that is not a Glassray key: say so once. */
    if ((opts.enabled ?? true) && this.key && !this.enabled) this.report(new Error("GLASSRAY_API_KEY does not look like a Glassray key (gr_...); signals are not sent"));
  }

  addEnricher(fn: Enricher): void {
    this.enrichers.push(fn);
  }

  /**
   * Sends one signal. source "user": something a person did or said about the agent's work
   * (undo, regenerate, edit, rating, reply). source "agent": something an agent said about its
   * own work (a tool that failed, a cut input, a guess it made). Fields from the current
   * context (user, work item, trace, agent) are filled in unless you set them.
   */
  signal(input: SignalInput): void {
    if (!this.enabled) return;
    try {
      const ctx = getContext();
      let s = applyContext(input, ctx);
      for (const enrich of this.enrichers) s = enrich(s, ctx);
      const rate = this.opts.sampleRate ?? 1;
      if (rate < 1 && Math.random() >= rate) return;
      const kept = this.opts.beforeSend ? this.opts.beforeSend(s) : s;
      if (!kept) return;
      if (this.queue.length >= (this.opts.maxQueue ?? 2000)) return;
      this.queue.push({ ...kept, at: kept.at ?? Date.now() });
    } catch (err) {
      this.report(err as Error);
      return;
    }
    this.schedule(this.queue.length);
  }

  /**
   * @internal Queues one OTLP span (JSON encoding) for /v1/traces. Used by wrapMcpServer's toolCalls
   * option. Same rules as signals: batched every second, sent in the background, never throws.
   */
  _span(span: OtlpSpan): void {
    if (!this.enabled) return;
    try {
      /* sampleRate keeps or drops whole traces, decided from the trace id, so a session is never cut in half */
      const rate = this.opts.sampleRate ?? 1;
      if (rate < 1 && parseInt(span.traceId.slice(0, 8), 16) / 0x1_0000_0000 >= rate) return;
      const kept = this.opts.beforeSendSpan ? this.opts.beforeSendSpan(span) : span;
      if (!kept) return;
      if (this.spans.length >= (this.opts.maxQueue ?? 2000)) return;
      this.spans.push(kept);
    } catch (err) {
      this.report(err as Error);
      return;
    }
    this.schedule(this.spans.length);
  }

  private schedule(queued: number) {
    if (queued >= BATCH) this.send();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.send();
      }, FLUSH_MS);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Sends everything queued so far and waits for it. Call before a short-lived process exits, or in tests. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.queue.length > 0 || this.spans.length > 0) this.send();
    await this.inflight;
  }

  private report(err: Error) {
    try {
      if (this.opts.onError) this.opts.onError(err);
      else if (Date.now() - this.lastWarn >= 60_000) {
        this.lastWarn = Date.now();
        console.warn(`[glassray] ${err.message}`);
      }
    } catch {
      /* an error handler that throws must not reach the caller either */
    }
  }

  private send() {
    if (this.queue.length > 0) this.post(this.url, { signals: this.queue.splice(0, BATCH) });
    if (this.spans.length > 0) {
      const spans = this.spans.splice(0, BATCH);
      this.post(this.tracesUrl, {
        resourceSpans: [
          {
            resource: { attributes: [{ key: "telemetry.sdk.name", value: { stringValue: "@glassray/signals" } }] },
            scopeSpans: [{ scope: { name: "@glassray/signals" }, spans }],
          },
        ],
      });
    }
  }

  private post(url: string, body: unknown) {
    this.inflight = this.inflight.then(async () => {
      try {
        const doFetch = this.opts.fetch ?? globalThis.fetch;
        const res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
          body: JSON.stringify(body),
        });
        if (!res.ok) this.report(new Error(`Glassray returned ${res.status}: ${(await res.text()).slice(0, 200)}`));
      } catch (err) {
        this.report(err as Error);
      }
    });
  }
}
