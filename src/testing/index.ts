import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { _swapClient, SignalsClient } from "../index.ts";
import type { SignalInput } from "../types.ts";

/*
 * checkMcpServer: is this MCP server set up so Glassray hears from it? Run it in your tests.
 *
 *   const result = await checkMcpServer(() => buildMyServer(), { failingCall: { tool: "get_doc", args: { id: "no-such-doc" } } })
 *   assert.ok(result.ok, formatChecks(result))
 *
 * It connects to the server in memory, plays a short scripted session (a tool fails, the agent reports
 * it, the person complains) against a stand-in Glassray, and checks what an agent would read and what
 * would be sent. Nothing leaves your machine. It cannot tell whether a real agent will follow the
 * instructions; that needs a live run with a model.
 */

export type CheckStatus = "pass" | "warn" | "fail";
export type Check = { name: string; status: CheckStatus; detail: string };
export type CheckResult = { ok: boolean; checks: Check[]; signals: SignalInput[] };

export type CheckOptions = {
  /** A call that fails on purpose (say, an id that does not exist). Checks that reports carry the calls before them. */
  failingCall?: { tool: string; args: Record<string, unknown> };
  /** Your tool for problems. Default report_issue (ours). */
  reportTool?: string;
  /** Arguments to pin for your report tool. Anything required that you leave out is filled from its own schema. */
  reportArgs?: Record<string, unknown>;
  /** Default pass_on_user_reaction (ours). Null when the person's words only travel in user_said fields. */
  reactionTool?: string | null;
};

/**
 * A test call for any report tool, ours or the product's own: every required field filled from the
 * schema the server advertises, so nobody has to list them by hand to run this check.
 */
function fillRequired(schema: unknown, text: string): Record<string, unknown> {
  const s = schema as { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] } | undefined;
  const out: Record<string, unknown> = {};
  for (const key of s?.required ?? []) {
    const prop = s?.properties?.[key];
    if (prop?.enum?.length) {
      /* prefer a value that reads as a problem, so the report lands where a real one would */
      const values = prop.enum as string[];
      out[key] = values.find((v) => /fail|error|bug|problem|confus/i.test(v)) ?? values[0];
    } else if (prop?.type === "number" || prop?.type === "integer") out[key] = 1;
    else if (prop?.type === "boolean") out[key] = false;
    else out[key] = text;
  }
  return out;
}

const NO_PERMISSION = /needs no permission|do not ask (them |the person )?first/i;
const EVEN_WHEN_RECOVERED = /even when you recover/i;

export async function checkMcpServer(makeServer: () => McpServer | Promise<McpServer>, o: CheckOptions = {}): Promise<CheckResult> {
  const checks: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });
  const signals: SignalInput[] = [];

  /* a stand-in Glassray: the default client, and any client of the server's own, send here */
  const capture: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/v1/signals")) signals.push(...(JSON.parse(String(init?.body)) as { signals: SignalInput[] }).signals);
    return new Response("{}", { status: 202 });
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).endsWith("/v1/signals") ? capture(input, init) : realFetch(input, init)) as typeof fetch;
  const stand = new SignalsClient({ apiKey: "gr_checkMcpServer", endpoint: "https://glassray.check", fetch: capture, onError: () => {} });
  const previous = _swapClient(stand);

  try {
    const server = await makeServer();
    const client = new Client({ name: "glassray-check", version: "1.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    const tools = (await client.listTools()).tools;
    const byName = new Map(tools.map((t) => [t.name, t]));

    /* 1. what an agent reads when it connects */
    const instructions = client.getInstructions() ?? "";
    if (NO_PERMISSION.test(instructions) && /exact words/i.test(instructions))
      add("instructions", "pass", "The server's instructions tell agents to report as they work and pass on the person's words, without asking first.");
    else
      add(
        "instructions",
        "fail",
        "The server's instructions do not tell agents to report and to pass on the person's words without asking. Call wrapMcpServer (it adds them), or append glassrayInstructions() to your own.",
      );

    /* 2. a way to report problems */
    const reportTool = o.reportTool ?? "report_issue";
    const report = byName.get(reportTool);
    if (!report) add("report tool", "fail", `No ${reportTool} tool. Leave reportTools on in wrapMcpServer, or pass reportTool with the name of yours.`);
    else if (!NO_PERMISSION.test(report.description ?? ""))
      add("report tool", "warn", `${reportTool}'s description does not say reporting needs no permission. Agents tend to ask the person first, and often never report.`);
    else if (!EVEN_WHEN_RECOVERED.test(report.description ?? ""))
      add(
        "report tool",
        "warn",
        `${reportTool}'s description does not say to report even after recovering. Agents that retried or worked around a problem read themselves as never having been stuck, and stay quiet.`,
      );
    else add("report tool", "pass", `${reportTool} is there, and says to report even after recovering, without asking.`);

    /* 3. a way to pass on the person's words */
    const reactionTool = o.reactionTool === undefined ? "pass_on_user_reaction" : o.reactionTool;
    const withFields = tools.filter((t) => t.inputSchema?.properties && "user_said" in t.inputSchema.properties).map((t) => t.name);
    if (reactionTool && byName.has(reactionTool)) add("person's words", "pass", `${reactionTool} is there${withFields.length ? `, and user_said on ${withFields.join(", ")}` : ""}.`);
    else if (withFields.length) add("person's words", "pass", `user_said on ${withFields.join(", ")}.`);
    else
      add(
        "person's words",
        "fail",
        "Nothing passes on what the person says in the agent's chat, which is where most reactions happen. Leave reactionTool on in wrapMcpServer, or add userReactionFields to your own tools.",
      );

    /* 4. a failing call, then a report: does the report carry the calls before it? */
    if (o.failingCall) {
      let failed = false;
      try {
        failed = Boolean((await client.callTool({ name: o.failingCall.tool, arguments: o.failingCall.args })).isError);
      } catch {
        failed = true;
      }
      if (!failed) add("failing call", "warn", `${o.failingCall.tool} did not fail with ${JSON.stringify(o.failingCall.args)}; pick arguments that make it fail.`);
    }
    if (report) {
      const result = await client.callTool({ name: reportTool, arguments: { ...fillRequired(report.inputSchema, "checkMcpServer: a test report"), ...o.reportArgs } });
      if (result.isError)
        add("report sent", "fail", `${reportTool} returned an error: ${JSON.stringify(result.content).slice(0, 300)}. Pin the arguments it needs in reportArgs.`);
    }

    /* 5. the person complains */
    if (reactionTool && byName.has(reactionTool))
      await client.callTool({ name: reactionTool, arguments: { said: "checkMcpServer: this is not good", reaction: "unhappy" } });

    await stand.flush();
    await new Promise((r) => setTimeout(r, 1100)); /* a client of the server's own sends within a second */
    await stand.flush();

    const fromAgent = signals.find((s) => s.source === "agent");
    if (report) {
      if (!fromAgent) add("report sent", "fail", "The report reached no Glassray client. Call init() before the server handles calls, or pass client to wrapMcpServer.");
      else {
        add("report sent", "pass", `The report arrived as a signal from the agent (kind ${fromAgent.kind}).`);
        const recent = (fromAgent.context?.recent_tool_calls ?? []) as { tool: string; ok: boolean }[];
        if (o.failingCall)
          add(
            "breadcrumbs",
            recent.some((c) => c.tool === o.failingCall!.tool && !c.ok) ? "pass" : "fail",
            recent.length
              ? `The report carries the calls before it: ${recent.map((c) => `${c.tool}${c.ok ? "" : " (failed)"}`).join(", ")}.`
              : "The report carries no tool calls. Call wrapMcpServer before registering tools, and give it a context that names the person.",
          );
      }
    }
    if (reactionTool && byName.has(reactionTool)) {
      const words = signals.find((s) => s.source === "user" && s.relayed_by === "agent");
      add(
        "person's words sent",
        words?.message === "checkMcpServer: this is not good" && words.sentiment === "negative" ? "pass" : "fail",
        words ? "The complaint arrived as a negative signal from the user, passed on by the agent." : "The complaint was not sent.",
      );
    }
    const any = signals.find((s) => s.source === "agent") ?? signals[0];
    if (any)
      add(
        "who",
        any.refs?.user ? "pass" : "warn",
        any.refs?.user
          ? `Signals say who the person is (${any.refs.user}).`
          : "Signals do not say who the person is. Give wrapMcpServer a context that returns { user }, so Glassray can link a person's reactions to the agent's reports.",
      );

    await client.close();
  } finally {
    _swapClient(previous);
    globalThis.fetch = realFetch;
  }

  return { ok: checks.every((c) => c.status !== "fail"), checks, signals };
}

/** One line per check, for an assertion message or a log. */
export function formatChecks(r: CheckResult): string {
  const mark = { pass: "✓", warn: "!", fail: "✗" };
  return r.checks.map((c) => `${mark[c.status]} ${c.name}: ${c.detail}`).join("\n");
}
