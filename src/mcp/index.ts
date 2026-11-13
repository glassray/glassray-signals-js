import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getClient } from "../index.ts";
import type { SignalsClient } from "../client.ts";
import { getContext, mergeContext, withContext, type SignalContext } from "../context.ts";
import { addBreadcrumbs, remember } from "./breadcrumbs.ts";
import { isUserReaction, reactionSignal } from "./fields.ts";
import { glassrayInstructions } from "./instructions.ts";
import { cleanArg, DEFAULT_IDLE_MS, hex, INTENT_ARG, MODEL_ARG, modelFromMeta, recordToolCall, sessionFor, withSelfReportArgs, type CallFacts, type ToolCallsOptions } from "./traces.ts";
import { IDEA_TOOL, REACTION_TOOL, REPORT_TOOL, registerGlassrayTools, type ReportToolsOptions, type ToolCallInfo } from "./tools.ts";

/*
 * Glassray for MCP servers (import from "@glassray/signals/mcp"). One line, right after creating the server
 * and before registering tools:
 *
 *   wrapMcpServer(server, { product: "Acme" })
 *
 * It then:
 *   - adds report_issue, share_feedback and pass_on_user_reaction;
 *   - adds a short paragraph to the server's instructions telling agents to use them as they work,
 *     without asking the person first;
 *   - runs every tool call inside a signal context (person, work item, agent client) and leaves a
 *     breadcrumb (tool, ok or failed, error, duration) that rides along on signals from agents;
 *   - notices user_said / user_reaction on any of your own tools (see userReactionFields) and sends
 *     the person's words as a signal from the user.
 * With toolCalls: true it also sends every tool call to Glassray as a span (one trace per agent
 * session), which fills the Sessions, Activity and Tools pages; see traces.ts. Without it, it sends no
 * traces: if you trace tool calls yourself, wrap after this and put your trace id in the context with
 * withContext({ trace }) so signals link to it.
 */

export type WrapMcpServerOptions = {
  /** Your product's name, used in what agents read. Defaults to the server's name. */
  product?: string;
  /** Who and what a tool call is about. Called for every call; may be async. Errors are ignored. */
  context?: (call: ToolCallInfo) => SignalContext | undefined | Promise<SignalContext | undefined>;
  /**
   * Adds report_issue and share_feedback. Default true. Set false if your server has its own; then
   * name it in ownReportTool so the instructions point agents at it.
   */
  reportTools?: boolean | ReportToolsOptions;
  /** The name of your own tool for problems, when reportTools is false. */
  ownReportTool?: string;
  /** The name of your own tool for ideas, when reportTools is false. */
  ownIdeaTool?: string;
  /** Adds pass_on_user_reaction. Default true. */
  reactionTool?: boolean;
  /** Adds the paragraph to the server's instructions. Default true. Use glassrayInstructions() to place it yourself. */
  instructions?: boolean;
  /** Defaults to the client from init(), looked up at call time. */
  client?: SignalsClient;
  /**
   * Sends every tool call to Glassray as a span, with the signals key: tool, duration, ok or failed,
   * and the session it belongs to (user, work item, agent client and version, model, intent). Signals
   * sent inside a call link to its session. No arguments or results are sent. Default false.
   */
  toolCalls?: boolean | ToolCallsOptions;
};

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };
type ToolCallback = (...args: unknown[]) => Promise<ToolResult> | ToolResult;
type Internals = {
  _instructions?: string;
  _serverInfo?: { name?: string };
};
/* the public Transport surface we read the client's initialize request from */
type TransportLike = { onmessage?: (message: unknown, extra?: unknown) => void };
/* the parts of the MCP SDK's RequestHandlerExtra we read */
type Extra = { sessionId?: string; _meta?: unknown; requestInfo?: { headers?: Record<string, string | string[] | undefined> } };

const errorText = (r: ToolResult) => r.content?.find((c) => c.type === "text")?.text?.slice(0, 300) ?? "tool returned an error";

export function wrapMcpServer(server: McpServer, opts: WrapMcpServerOptions = {}): void {
  const inner = server.server as unknown as Internals;
  const product = opts.product ?? inner._serverInfo?.name ?? "this product";
  const clientFor = () => opts.client ?? getClient();
  const register = server.registerTool.bind(server);
  const withUserFields: string[] = [];
  const reportTools = opts.reportTools ?? true;
  const reactionTool = opts.reactionTool ?? true;
  /* only the tools we add are ours: a product's own report_issue still gets breadcrumbs */
  const ours = new Set([...(reportTools ? [REPORT_TOOL, IDEA_TOOL] : []), ...(reactionTool ? [REACTION_TOOL] : [])]);

  const toolCalls: ToolCallsOptions | null = opts.toolCalls ? (opts.toolCalls === true ? {} : opts.toolCalls) : null;
  /* tools whose input schema got llm_model and intent from us: we take them out before your callback */
  const selfReport = new Map<string, string[]>();
  let protocolVersion: string | undefined;
  const connection = hex(8);
  if (toolCalls) {
    /* The SDK does not expose the protocol version, so read it from the client's initialize request as it
       arrives on the transport (public API: connect and Transport.onmessage). Over HTTP the
       mcp-protocol-version header also carries it. */
    const connect = server.connect.bind(server);
    server.connect = (async (transport: TransportLike) => {
      await connect(transport as never);
      try {
        const handle = transport.onmessage;
        if (typeof handle === "function")
          transport.onmessage = (message, extra) => {
            try {
              const m = message as { method?: string; params?: { protocolVersion?: unknown } };
              if (m?.method === "initialize" && typeof m.params?.protocolVersion === "string") protocolVersion = m.params.protocolVersion;
            } catch {
              /* never in the way of a message */
            }
            handle.call(transport, message, extra);
          };
      } catch {
        /* no protocol version, nothing else lost */
      }
    }) as typeof server.connect;
  }

  const traced =
    (tool: string, cb: ToolCallback, takesArgs: boolean): ToolCallback =>
    async (...callArgs) => {
      const sc = clientFor();
      if (sc) addBreadcrumbs(sc);
      const rawArgs = ((takesArgs ? callArgs[0] : {}) ?? {}) as Record<string, unknown>;
      const extra = ((takesArgs ? callArgs[1] : callArgs[0]) ?? {}) as Extra;
      /* the self-reported fields are ours: your callback and context function never see them */
      const added = selfReport.get(tool);
      let args = rawArgs;
      if (added && takesArgs && typeof rawArgs === "object") {
        args = { ...rawArgs };
        for (const k of added) delete args[k];
        callArgs = [args, ...callArgs.slice(1)];
      }
      const clientInfo = server.server.getClientVersion();
      const agentClient = clientInfo?.name;
      let ctx: SignalContext = agentClient ? { agent: { client: agentClient } } : {};
      try {
        const extraCtx = await opts.context?.({ tool, args, ...(agentClient ? { client: agentClient } : {}) });
        if (extraCtx) ctx = mergeContext(ctx, extraCtx);
      } catch {
        /* a broken context function must not break the tool */
      }

      /* tool calls as spans: find this call's session, and link signals sent inside it to its trace */
      let span: { session: ReturnType<typeof sessionFor>; facts: CallFacts; ctx: SignalContext } | null = null;
      /* Glassray's own tools record no span, so they start no session either: their signals link to the
         trace of the recent calls through the breadcrumbs */
      if (toolCalls && sc?.enabled && !ours.has(tool)) {
        try {
          const header = extra.requestInfo?.headers?.["mcp-protocol-version"];
          const facts: CallFacts = {
            tool,
            ...(typeof extra.sessionId === "string" && extra.sessionId ? { mcpSessionId: extra.sessionId } : {}),
            ...(agentClient ? { client: agentClient } : {}),
            ...(clientInfo?.version ? { clientVersion: clientInfo.version } : {}),
            connection,
          };
          const pv = protocolVersion ?? (typeof header === "string" ? header : undefined);
          if (pv) facts.protocolVersion = pv;
          const model = cleanArg(rawArgs[MODEL_ARG]) ?? modelFromMeta(extra._meta);
          if (model) facts.model = model;
          const intent = added?.includes(INTENT_ARG) ? cleanArg(rawArgs[INTENT_ARG], 300) : undefined;
          if (intent) facts.intent = intent;
          facts.serviceName = toolCalls.serviceName ?? inner._serverInfo?.name;
          const session = sessionFor(ctx, facts, Date.now(), toolCalls.idleMs ?? DEFAULT_IDLE_MS);
          /* only the trace: a session id here would change breadcrumb and rate-limit keys */
          if (!ctx.trace) ctx = { ...ctx, trace: session.traceId };
          span = { session, facts, ctx };
        } catch {
          span = null;
        }
      }

      return withContext(ctx, async () => {
        const start = Date.now();
        const now = () => getContext();
        const finish = (error?: string) => {
          if (span && sc && !ours.has(tool))
            recordToolCall(sc, { session: span.session, ctx: span.ctx, facts: span.facts, start, end: Date.now(), ...(error !== undefined ? { error } : {}) });
        };
        /* the person's words, on one of your own tools: sent whatever the tool does */
        if (typeof args.user_said === "string" && !(ours.has(tool) && tool === REACTION_TOOL)) {
          const s = reactionSignal({ said: args.user_said, ...(isUserReaction(args.user_reaction) ? { reaction: args.user_reaction } : {}), via: tool });
          if (s) sc?.signal(s);
        }
        try {
          const result = await cb(...callArgs);
          if (!ours.has(tool))
            remember(now(), {
              tool,
              ok: !result?.isError,
              ms: Date.now() - start,
              ...(result?.isError ? { error: errorText(result) } : {}),
              ...(now().trace ? { trace: now().trace } : {}),
              at: Date.now(),
            });
          finish(result?.isError ? errorText(result) : undefined);
          return result;
        } catch (err) {
          const message = String((err as Error)?.message ?? err).slice(0, 300);
          if (!ours.has(tool))
            remember(now(), { tool, ok: false, ms: Date.now() - start, error: message, ...(now().trace ? { trace: now().trace } : {}), at: Date.now() });
          finish(message);
          throw err;
        }
      });
    };

  /* the SDK's overloads (with and without an input schema) cannot be restated generically */
  server.registerTool = ((name: string, config: { inputSchema?: Record<string, unknown> }, cb: ToolCallback) => {
    if (config.inputSchema && "user_said" in config.inputSchema && !ours.has(name)) withUserFields.push(name);
    if (toolCalls && (toolCalls.selfReport ?? true) && config.inputSchema && !ours.has(name)) {
      const next = withSelfReportArgs(config.inputSchema, z);
      if (next && next.added.length) {
        selfReport.set(name, next.added);
        config = { ...config, inputSchema: next.shape };
      }
    }
    return register(name, config as never, traced(name, cb, config.inputSchema !== undefined) as never);
  }) as unknown as typeof server.registerTool;

  registerGlassrayTools(server, { product, reportTools: reportTools === true ? {} : reportTools, reactionTool, clientFor });

  /* The server reads its instructions when an agent connects, after every tool is registered,
     so the paragraph names the tools this server really has. */
  if (opts.instructions ?? true) {
    let own = inner._instructions;
    Object.defineProperty(inner, "_instructions", {
      configurable: true,
      get: () =>
        [
          own,
          glassrayInstructions({
            product,
            reportTool: reportTools ? REPORT_TOOL : (opts.ownReportTool ?? null),
            ideaTool: reportTools ? IDEA_TOOL : (opts.ownIdeaTool ?? null),
            reactionTool: reactionTool ? REACTION_TOOL : null,
            toolsWithUserFields: withUserFields,
          }),
        ]
          .filter(Boolean)
          .join("\n\n"),
      set: (v: string | undefined) => {
        own = v;
      },
    });
  }
}

export { recentToolCalls, resetBreadcrumbs } from "./breadcrumbs.ts";
export { resetToolCallSessions, type ToolCallsOptions } from "./traces.ts";
export { userReactionFields, reactionSignal, USER_REACTIONS, type UserReaction } from "./fields.ts";
export { glassrayInstructions, type InstructionsOptions } from "./instructions.ts";
export { REACTION_TOOL, type AgentReport, type ReportToolsOptions, type ToolCallInfo } from "./tools.ts";
