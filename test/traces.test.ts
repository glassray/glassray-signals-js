import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { init, signal, flush, resetContext, SignalsClient, type SignalInput, type SignalContext } from "../src/index.ts";
import { wrapMcpServer, resetBreadcrumbs, resetToolCallSessions, type ToolCallsOptions } from "../src/mcp/index.ts";
import { sessionFor } from "../src/mcp/traces.ts";

type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue?: string } }[];
  status?: { code: number; message?: string };
};
type OtlpBody = { resourceSpans: { scopeSpans: { spans: Span[] }[] }[] };

let signals: SignalInput[] = [];
let traceBodies: OtlpBody[] = [];
let urls: string[] = [];
const fakeFetch: typeof fetch = async (url, init) => {
  urls.push(String(url));
  const body = JSON.parse(String(init?.body));
  if (String(url).endsWith("/v1/traces")) traceBodies.push(body as OtlpBody);
  else signals.push(...(body as { signals: SignalInput[] }).signals);
  return new Response("{}", { status: 200 });
};
const spans = () => traceBodies.flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
const attr = (s: Span, k: string) => s.attributes.find((a) => a.key === k)?.value.stringValue;
const roots = () => spans().filter((s) => !s.parentSpanId);
const tools = () => spans().filter((s) => s.parentSpanId);

beforeEach(() => {
  signals = [];
  traceBodies = [];
  urls = [];
  resetContext();
  resetBreadcrumbs();
  resetToolCallSessions();
  init({ apiKey: "gr_test", endpoint: "https://glassray.test", fetch: fakeFetch, onError: () => {} });
});

async function connect(server: McpServer, name = "claude-code") {
  const client = new Client({ name, version: "2.1.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return client;
}

function demo(toolCalls: boolean | ToolCallsOptions = true, context?: (args: Record<string, unknown>) => SignalContext) {
  const server = new McpServer({ name: "demo-mcp", version: "1.0.0" });
  const seen: Record<string, unknown>[] = [];
  wrapMcpServer(server, {
    product: "Demo",
    toolCalls,
    context: ({ args }) => context?.(args) ?? { user: "maya", ...(typeof args.canvas_id === "string" ? { workItem: { type: "canvas", id: args.canvas_id } } : {}) },
  });
  server.registerTool("edit_canvas", { description: "Edit", inputSchema: { canvas_id: z.string() } }, async (args) => {
    seen.push(args);
    signal({ source: "agent", kind: "uncertain_decision", message: "guessed the font" });
    return { content: [{ type: "text", text: "ok" }] };
  });
  server.registerTool("broken", { description: "Fails", inputSchema: { canvas_id: z.string() } }, async () => ({ isError: true, content: [{ type: "text", text: "component not found" }] }));
  server.registerTool("throws", { description: "Throws", inputSchema: { canvas_id: z.string() } }, async () => {
    throw new Error("database down");
  });
  server.registerTool("ping", { description: "No arguments" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  return { server, seen };
}

test("off by default: no spans are sent", async () => {
  const server = new McpServer({ name: "demo", version: "1.0.0" });
  wrapMcpServer(server, { product: "Demo", context: () => ({ user: "maya" }) });
  server.registerTool("ping", { description: "p", inputSchema: { a: z.string() } }, async () => ({ content: [{ type: "text", text: "pong" }] }));
  const client = await connect(server);
  await client.callTool({ name: "ping", arguments: { a: "x" } });
  await flush();
  assert.equal(urls.filter((u) => u.endsWith("/v1/traces")).length, 0);
  const listed = (await client.listTools()).tools.find((t) => t.name === "ping")!;
  assert.ok(!("llm_model" in (listed.inputSchema.properties ?? {})), "no extra arguments without toolCalls");
});

test("each tool call becomes a tool span under one root span per session, batched into one request", async () => {
  const { server } = demo();
  const client = await connect(server);
  await client.callTool({ name: "edit_canvas", arguments: { canvas_id: "c1" } });
  await client.callTool({ name: "edit_canvas", arguments: { canvas_id: "c1" } });
  await client.callTool({ name: "ping", arguments: {} });
  await flush();
  assert.equal(urls.filter((u) => u === "https://glassray.test/v1/traces").length, 1, "one batch");
  /* ping has no work item, so it is a different session for the same user */
  assert.equal(roots().length, 2);
  const [root] = roots().filter((r) => attr(r, "work_item") === "canvas:c1");
  const calls = tools().filter((s) => s.traceId === root!.traceId);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.parentSpanId, root!.spanId);
    assert.equal(attr(c, "glassray.span.kind"), "tool");
    assert.equal(attr(c, "gen_ai.tool.name"), "edit_canvas");
    assert.equal(c.status?.code, 1);
    assert.ok(BigInt(c.endTimeUnixNano) >= BigInt(c.startTimeUnixNano));
  }
  assert.match(root!.traceId, /^[0-9a-f]{32}$/);
  assert.match(root!.spanId, /^[0-9a-f]{16}$/);
});

test("the root span carries user, work item, session, agent client and version, protocol, model and intent", async () => {
  const { server } = demo();
  const client = await connect(server);
  await client.callTool({ name: "edit_canvas", arguments: { canvas_id: "c1", llm_model: "claude-opus-4-5", intent: "add a pricing section" } });
  await flush();
  const root = roots()[0]!;
  assert.equal(root.name, "mcp session");
  assert.equal(attr(root, "work_item"), "canvas:c1");
  assert.equal(attr(root, "user.id"), "maya");
  assert.match(attr(root, "session.id") ?? "", /^mcp-[0-9a-f]{16}$/);
  assert.equal(attr(root, "mcp.client.name"), "claude-code");
  assert.equal(attr(root, "mcp.client.version"), "2.1.0");
  assert.match(attr(root, "mcp.protocol.version") ?? "", /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(attr(root, "gen_ai.request.model"), "claude-opus-4-5");
  assert.equal(attr(root, "mcp.intent"), "add a pricing section");
  assert.equal(attr(root, "service.name"), "demo-mcp");
  /* the tool span repeats them, since the root is written once */
  const call = tools()[0]!;
  assert.equal(attr(call, "user.id"), "maya");
  assert.equal(attr(call, "session.id"), attr(root, "session.id"));
  assert.equal(attr(call, "gen_ai.request.model"), "claude-opus-4-5");
});

test("llm_model and intent are optional arguments agents see, and your callback never does", async () => {
  const { server, seen } = demo();
  const client = await connect(server);
  const listed = (await client.listTools()).tools.find((t) => t.name === "edit_canvas")!;
  assert.ok("llm_model" in (listed.inputSchema.properties ?? {}));
  assert.ok("intent" in (listed.inputSchema.properties ?? {}));
  assert.deepEqual(listed.inputSchema.required, ["canvas_id"]);
  await client.callTool({ name: "edit_canvas", arguments: { canvas_id: "c1", llm_model: "gpt-5" } });
  await client.callTool({ name: "edit_canvas", arguments: { canvas_id: "c1" } });
  assert.deepEqual(seen, [{ canvas_id: "c1" }, { canvas_id: "c1" }]);
  await flush();
  /* the model, once said, stays with the session */
  assert.deepEqual(tools().map((s) => attr(s, "gen_ai.request.model")), ["gpt-5", "gpt-5"]);
});

test("selfReport: false leaves input schemas alone", async () => {
  const { server } = demo({ selfReport: false });
  const client = await connect(server);
  const listed = (await client.listTools()).tools.find((t) => t.name === "edit_canvas")!;
  assert.deepEqual(Object.keys(listed.inputSchema.properties ?? {}), ["canvas_id"]);
});

test("a failed call is an error span with its message, whether the tool returns an error or throws", async () => {
  const { server } = demo();
  const client = await connect(server);
  const r = await client.callTool({ name: "broken", arguments: { canvas_id: "c1" } });
  assert.equal(r.isError, true);
  const thrown = await client.callTool({ name: "throws", arguments: { canvas_id: "c1" } });
  assert.equal(thrown.isError, true);
  await flush();
  const [broken, threw] = tools();
  assert.deepEqual(broken!.status, { code: 2, message: "component not found" });
  assert.equal(attr(broken!, "error.type"), "tool_error");
  assert.deepEqual(threw!.status, { code: 2, message: "database down" });
});

test("signals sent inside a wrapped call link to its session's trace", async () => {
  const { server } = demo();
  const client = await connect(server);
  await client.callTool({ name: "edit_canvas", arguments: { canvas_id: "c1" } });
  /* the report names no work item, so it starts a session of its own for maya; it still links to one */
  const report = await client.callTool({ name: "report_issue", arguments: { kind: "confusing", needed: "one font tool", tried: "called both", suggestion: "merge them" } });
  assert.ok(!report.isError, JSON.stringify(report));
  await flush();
  const root = roots()[0]!;
  const fromTool = signals.find((s) => s.kind === "uncertain_decision")!;
  assert.equal(fromTool.refs?.trace, root.traceId);
  /* the trace only: a session id in the context would change breadcrumb and rate-limit keys */
  assert.equal(fromTool.refs?.session, undefined);
  /* the report starts no session of its own: it links to the trace of the calls before it */
  const reported = signals.find((s) => s.kind === "confusing")!;
  assert.equal(reported.refs?.trace, root.traceId);
  assert.equal(roots().length, 1);
  /* Glassray's own tools are not counted as product tool calls */
  assert.ok(!tools().some((s) => attr(s, "gen_ai.tool.name") === "report_issue"));
});

test("a trace or session the product already set in the context wins", async () => {
  const { server } = demo(true, () => ({ user: "maya", trace: "0123456789abcdef0123456789abcdef", session: "conv-42" }));
  const client = await connect(server);
  await client.callTool({ name: "edit_canvas", arguments: { canvas_id: "c1" } });
  await flush();
  assert.equal(signals[0]!.refs?.trace, "0123456789abcdef0123456789abcdef");
  assert.equal(attr(roots()[0]!, "session.id"), "conv-42");
});

test("sessions: an MCP session id groups calls; without one, user + work item + client with an idle gap", () => {
  const t0 = 1_000_000;
  const byId = sessionFor({ user: "maya" }, { tool: "a", mcpSessionId: "abc" }, t0);
  assert.equal(sessionFor({ user: "jo", workItem: "x" }, { tool: "b", mcpSessionId: "abc" }, t0 + 60_000).traceId, byId.traceId, "one MCP session, one trace");
  assert.equal(byId.id, "abc");
  /* a named session that comes back after the gap keeps its id, in a new trace */
  const back = sessionFor({ user: "maya" }, { tool: "c", mcpSessionId: "abc" }, t0 + 60_000 + 31 * 60_000);
  assert.notEqual(back.traceId, byId.traceId);
  assert.equal(back.id, "abc");

  /* nothing says who is calling: one session per connection, not one per client */
  const one = sessionFor({}, { tool: "a", client: "claude-code", connection: "c1" }, t0);
  assert.notEqual(sessionFor({}, { tool: "a", client: "claude-code", connection: "c2" }, t0).traceId, one.traceId);
  assert.equal(sessionFor({}, { tool: "b", client: "claude-code", connection: "c1" }, t0 + 1000).traceId, one.traceId);

  const derived = sessionFor({ user: "maya", workItem: "canvas:c1" }, { tool: "a", client: "cursor" }, t0);
  assert.equal(sessionFor({ user: "maya", workItem: "canvas:c1" }, { tool: "b", client: "cursor" }, t0 + 29 * 60_000).traceId, derived.traceId);
  assert.notEqual(sessionFor({ user: "maya", workItem: "canvas:c1" }, { tool: "b", client: "claude-code" }, t0).traceId, derived.traceId, "another client");
  assert.notEqual(sessionFor({ user: "maya", workItem: "canvas:c2" }, { tool: "b", client: "cursor" }, t0).traceId, derived.traceId, "another work item");
  /* the gap counts from the last call */
  const later = sessionFor({ user: "maya", workItem: "canvas:c1" }, { tool: "c", client: "cursor" }, t0 + 29 * 60_000 + 31 * 60_000);
  assert.notEqual(later.traceId, derived.traceId, "30 idle minutes start a new session");
});

test("idleMs sets the gap", async () => {
  const { server } = demo({ idleMs: 1 });
  const client = await connect(server);
  await client.callTool({ name: "edit_canvas", arguments: { canvas_id: "c1" } });
  await new Promise((r) => setTimeout(r, 10));
  await client.callTool({ name: "edit_canvas", arguments: { canvas_id: "c1" } });
  await flush();
  assert.equal(roots().length, 2);
});

test("spans are batched: 200 per request, and a flush sends the rest", async () => {
  const sc = new SignalsClient({ apiKey: "gr_test", endpoint: "https://glassray.test", fetch: fakeFetch });
  const span = (i: number) => ({ traceId: "t", spanId: `s${i}`, name: "x", startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: [] });
  for (let i = 0; i < 250; i++) sc._span(span(i));
  await flush(); /* the module client: nothing of ours */
  assert.equal(traceBodies.length, 1, "a full batch goes at once");
  await sc.flush();
  assert.equal(traceBodies.length, 2);
  assert.equal(spans().length, 250);
});

test("sampleRate keeps or drops whole traces; beforeSendSpan edits or drops spans", async () => {
  const sc = new SignalsClient({
    apiKey: "gr_test",
    endpoint: "https://glassray.test",
    fetch: fakeFetch,
    sampleRate: 0.5,
    beforeSendSpan: (s) => (s.name === "drop" ? null : { ...s, attributes: s.attributes.filter((a) => a.key !== "mcp.intent") }),
  });
  const span = (traceId: string, name = "x") => ({
    traceId,
    spanId: "s",
    name,
    startTimeUnixNano: "1",
    endTimeUnixNano: "2",
    attributes: [{ key: "mcp.intent", value: { stringValue: "email jo@example.com" } }],
  });
  sc._span(span("00000000000000000000000000000001"));
  sc._span(span("00000000000000000000000000000002", "drop"));
  sc._span(span("ffffffff000000000000000000000001"));
  await sc.flush();
  assert.equal(spans().length, 1);
  assert.equal(spans()[0]!.traceId, "00000000000000000000000000000001");
  assert.deepEqual(spans()[0]!.attributes, []);
});

test("ids still work where there is no global crypto (Node 18)", () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
  try {
    const s = sessionFor({ user: "maya" }, { tool: "a" }, Date.now());
    assert.match(s.traceId, /^[0-9a-f]{32}$/);
    assert.match(s.rootSpanId, /^[0-9a-f]{16}$/);
  } finally {
    if (real) Object.defineProperty(globalThis, "crypto", real);
  }
});

test("an unreachable Glassray never breaks a tool call", async () => {
  const errors: Error[] = [];
  init({
    apiKey: "gr_test",
    fetch: async () => {
      throw new Error("offline");
    },
    onError: (e) => errors.push(e),
  });
  const { server } = demo();
  const client = await connect(server);
  const r = await client.callTool({ name: "edit_canvas", arguments: { canvas_id: "c1" } });
  assert.equal((r.content as { text: string }[])[0]!.text, "ok");
  await flush();
  assert.ok(errors.length > 0);
});

test("without a key, nothing is recorded and tools still work", async () => {
  init({ apiKey: "", fetch: fakeFetch, onError: () => {} });
  const { server } = demo();
  const client = await connect(server);
  const r = await client.callTool({ name: "ping", arguments: {} });
  assert.equal((r.content as { text: string }[])[0]!.text, "pong");
  await flush();
  assert.equal(urls.length, 0);
});
