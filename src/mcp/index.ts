import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getClient } from "../index.ts";
import type { SignalsClient } from "../client.ts";
import { getContext, mergeContext, withContext, type SignalContext } from "../context.ts";
import { addBreadcrumbs, remember } from "./breadcrumbs.ts";
import { isUserReaction, reactionSignal } from "./fields.ts";
import { glassrayInstructions } from "./instructions.ts";
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
 * It sends no traces. If you trace tool calls yourself, wrap after this and put your trace id in the
 * context with withContext({ trace }) so signals link to it.
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
};

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };
type ToolCallback = (...args: unknown[]) => Promise<ToolResult> | ToolResult;
type Internals = { _instructions?: string; _serverInfo?: { name?: string } };

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

  const traced =
    (tool: string, cb: ToolCallback, takesArgs: boolean): ToolCallback =>
    async (...callArgs) => {
      const sc = clientFor();
      if (sc) addBreadcrumbs(sc);
      const args = ((takesArgs ? callArgs[0] : {}) ?? {}) as Record<string, unknown>;
      const agentClient = server.server.getClientVersion()?.name;
      let ctx: SignalContext = agentClient ? { agent: { client: agentClient } } : {};
      try {
        const extra = await opts.context?.({ tool, args, ...(agentClient ? { client: agentClient } : {}) });
        if (extra) ctx = mergeContext(ctx, extra);
      } catch {
        /* a broken context function must not break the tool */
      }
      return withContext(ctx, async () => {
        const start = Date.now();
        const now = () => getContext();
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
          return result;
        } catch (err) {
          if (!ours.has(tool))
            remember(now(), { tool, ok: false, ms: Date.now() - start, error: String((err as Error)?.message ?? err).slice(0, 300), at: Date.now() });
          throw err;
        }
      });
    };

  /* the SDK's overloads (with and without an input schema) cannot be restated generically */
  server.registerTool = ((name: string, config: { inputSchema?: Record<string, unknown> }, cb: ToolCallback) => {
    if (config.inputSchema && "user_said" in config.inputSchema && !ours.has(name)) withUserFields.push(name);
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
export { userReactionFields, reactionSignal, USER_REACTIONS, type UserReaction } from "./fields.ts";
export { glassrayInstructions, type InstructionsOptions } from "./instructions.ts";
export { REACTION_TOOL, type AgentReport, type ReportToolsOptions, type ToolCallInfo } from "./tools.ts";
