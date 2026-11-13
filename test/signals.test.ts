import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { init, signal, flush, withContext, setContext, resetContext, getClient, type SignalInput } from "../src/index.ts";
import { wrapMcpServer, resetBreadcrumbs, userReactionFields } from "../src/mcp/index.ts";
import { checkMcpServer, formatChecks } from "../src/testing/index.ts";

let sent: SignalInput[] = [];
const fakeFetch: typeof fetch = async (_url, init) => {
  sent.push(...(JSON.parse(String(init?.body)) as { signals: SignalInput[] }).signals);
  return new Response("{}", { status: 202 });
};

beforeEach(() => {
  sent = [];
  resetContext();
  resetBreadcrumbs();
  init({ apiKey: "gr_test", endpoint: "https://glassray.test", fetch: fakeFetch, onError: () => {} });
});

test("does nothing before init or without a key, and never throws", async () => {
  init({ apiKey: "", onError: () => {} });
  signal({ source: "user", kind: "undo" });
  await flush();
  assert.equal(sent.length, 0);
});

test("fills user, work item, trace and agent from the context; explicit fields win", async () => {
  setContext({ agent: { name: "acme-mcp" } });
  withContext({ user: "maya", workItem: { type: "canvas", id: "c1" }, trace: "t1" }, () => {
    signal({ source: "user", kind: "undo" });
    signal({ source: "user", kind: "undo", refs: { user: "jo" }, work_item: "canvas:c2" });
  });
  await flush();
  assert.deepEqual(sent[0]!.refs, { user: "maya", trace: "t1" });
  assert.deepEqual(sent[0]!.work_item, { type: "canvas", id: "c1" });
  assert.deepEqual(sent[0]!.agent, { name: "acme-mcp" });
  assert.equal(sent[1]!.refs?.user, "jo");
  assert.equal(sent[1]!.work_item, "canvas:c2");
});

test("context follows async work", async () => {
  await withContext({ user: "maya" }, async () => {
    await new Promise((r) => setTimeout(r, 5));
    signal({ source: "user", kind: "undo" });
  });
  await flush();
  assert.equal(sent[0]!.refs?.user, "maya");
});

test("beforeSend can edit or drop a signal", async () => {
  init({
    apiKey: "gr_test",
    fetch: fakeFetch,
    beforeSend: (s) => (s.kind === "secret" ? null : { ...s, message: "[scrubbed]" }),
  });
  signal({ source: "user", kind: "secret" });
  signal({ source: "user", kind: "correction", message: "my password is hunter2" });
  await flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.message, "[scrubbed]");
});

async function connect(server: McpServer) {
  const client = new Client({ name: "claude-code", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  return client;
}

function demoServer(reportTools: boolean) {
  const server = new McpServer({ name: "demo", version: "1.0.0" });
  wrapMcpServer(server, {
    product: "Demo",
    reportTools,
    context: ({ args }) => ({ user: "maya", ...(typeof args.canvas_id === "string" ? { workItem: { type: "canvas", id: args.canvas_id } } : {}) }),
  });
  server.registerTool("insert_instance", { inputSchema: { canvas_id: z.string(), name: z.string() } }, async ({ name }) =>
    name === "PricingCard"
      ? { isError: true, content: [{ type: "text" as const, text: `component ${name} not found` }] }
      : { content: [{ type: "text" as const, text: "ok" }] },
  );
  server.registerTool("draw_rect", { inputSchema: { canvas_id: z.string() } }, async () => {
    signal({ source: "user", kind: "should_carry_context" });
    return { content: [{ type: "text" as const, text: "ok" }] };
  });
  return server;
}

test("wrapped tools run in context: signals inside them know the user, work item and agent client", async () => {
  const client = await connect(demoServer(false));
  await client.callTool({ name: "draw_rect", arguments: { canvas_id: "c1" } });
  await flush();
  assert.equal(sent[0]!.refs?.user, "maya");
  assert.deepEqual(sent[0]!.work_item, { type: "canvas", id: "c1" });
  assert.equal(sent[0]!.agent?.client, "claude-code");
});

test("a tool's error result comes back unchanged", async () => {
  const client = await connect(demoServer(false));
  const r = await client.callTool({ name: "insert_instance", arguments: { canvas_id: "c1", name: "PricingCard" } });
  assert.equal(r.isError, true);
});

test("report_issue sends a signal from the agent carrying the recent tool calls", async () => {
  const client = await connect(demoServer(true));
  await client.callTool({ name: "insert_instance", arguments: { canvas_id: "c1", name: "PricingCard" } });
  await client.callTool({ name: "draw_rect", arguments: { canvas_id: "c1" } });
  await flush();
  sent = [];
  /* the report names no canvas: its recent calls are found through the user */
  const r = await client.callTool({ name: "report_issue", arguments: { kind: "tool_failure", needed: "PricingCard on the canvas", tried: "insert_instance twice, then drew rectangles", suggestion: "match component names case-insensitively", tool: "insert_instance" } });
  assert.match(String((r.content as { text: string }[])[0]!.text), /Demo team/);
  await flush();
  const report = sent.find((s) => s.source === "agent")!;
  assert.equal(report.kind, "tool_failure");
  assert.equal(report.tool, "insert_instance");
  assert.equal(report.refs?.user, "maya");
  assert.equal(report.agent?.client, "claude-code");
  const recent = report.context?.recent_tool_calls as { tool: string; ok: boolean }[];
  assert.deepEqual(
    recent.map((c) => [c.tool, c.ok]),
    [
      ["insert_instance", false],
      ["draw_rect", true],
    ],
  );
});

test("breadcrumbs ride along when the report shares the work item", async () => {
  const server = new McpServer({ name: "demo", version: "1.0.0" });
  wrapMcpServer(server, { product: "Demo", context: () => ({ user: "maya", workItem: { type: "canvas", id: "c1" } }) });
  server.registerTool("insert_instance", { inputSchema: { name: z.string() } }, async ({ name }) => ({
    isError: true,
    content: [{ type: "text" as const, text: `component ${name} not found` }],
  }));
  const client = await connect(server);
  await withContext({ trace: "abc" }, () => client.callTool({ name: "insert_instance", arguments: { name: "PricingCard" } }));
  await client.callTool({ name: "report_issue", arguments: { kind: "tool_failure", needed: "PricingCard", tried: "insert_instance" } });
  await flush();
  const report = sent.find((s) => s.source === "agent")!;
  const recent = report.context?.recent_tool_calls as { tool: string; ok: boolean; error?: string }[];
  assert.equal(recent.length, 1);
  assert.deepEqual([recent[0]!.tool, recent[0]!.ok], ["insert_instance", false]);
  assert.match(recent[0]!.error!, /not found/);
});

test("onReport can store a report or refuse it", async () => {
  const stored: string[] = [];
  const server = new McpServer({ name: "demo", version: "1.0.0" });
  wrapMcpServer(server, {
    product: "Demo",
    reportTools: {
      onReport: (r) => {
        if (r.message === "spam") throw new Error("feedback limit reached");
        stored.push(r.message);
      },
    },
  });
  const client = await connect(server);
  await client.callTool({ name: "share_feedback", arguments: { kind: "idea", message: "a batch tool" } });
  const refused = await client.callTool({ name: "report_issue", arguments: { kind: "other", needed: "spam", tried: "nothing" } });
  await flush();
  assert.deepEqual(stored, ["a batch tool"]);
  assert.equal(refused.isError, true);
  assert.equal(sent.filter((s) => s.source === "agent").length, 1);
});

/* ---------- what agents read, and the person's words ---------- */

test("one line adds the three tools and tells agents to use them without asking", async () => {
  const server = new McpServer({ name: "acme", version: "1.0.0" }, { instructions: "Acme draws diagrams." });
  wrapMcpServer(server);
  server.registerTool("draw", { inputSchema: { canvas_id: z.string() } }, async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
  const client = await connect(server);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["draw", "pass_on_user_reaction", "report_issue", "share_feedback"]);
  const text = client.getInstructions() ?? "";
  assert.ok(text.startsWith("Acme draws diagrams."), "the server's own instructions come first");
  assert.match(text, /## Helping acme improve/, "the product name defaults to the server's name");
  assert.match(text, /needs no permission.*Do not ask first/);
  assert.match(text, /call report_issue right away/);
  assert.match(text, /call pass_on_user_reaction/);
  for (const t of (await client.listTools()).tools.filter((t) => t.name !== "draw")) assert.match(t.description ?? "", /needs no permission/, t.name);
  /* an agent that recovers fast reads its own escape into a softer wording, so both say this outright */
  assert.match(text, /even when you recover/i, "the instructions say recovering is not an excuse");
  const report = (await client.listTools()).tools.find((t) => t.name === "report_issue")!;
  assert.match(report.description ?? "", /even when you recovered/i);
  assert.match(report.description ?? "", /that is the report/i);
});

test("a server with its own report tool keeps it, and the instructions point at it", async () => {
  const server = new McpServer({ name: "acme", version: "1.0.0" });
  wrapMcpServer(server, { product: "Acme", reportTools: false, ownReportTool: "report_problem" });
  const client = await connect(server);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names, ["pass_on_user_reaction"]);
  const text = client.getInstructions() ?? "";
  assert.match(text, /call report_problem right away/);
  assert.doesNotMatch(text, /share_feedback/);
});

test("pass_on_user_reaction sends the person's exact words as a signal from the user, relayed by the agent", async () => {
  const server = demoServer(false);
  const client = await connect(server);
  await client.callTool({ name: "pass_on_user_reaction", arguments: { said: "this is not good", reaction: "unhappy", about: "priority chips on Issues" } });
  await flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    { source: sent[0]!.source, kind: sent[0]!.kind, sentiment: sent[0]!.sentiment, message: sent[0]!.message, relayed_by: sent[0]!.relayed_by },
    { source: "user", kind: "correction", sentiment: "negative", message: "this is not good", relayed_by: "agent" },
  );
  assert.equal(sent[0]!.refs?.user, "maya");
  assert.equal(sent[0]!.agent?.client, "claude-code");
  assert.deepEqual(sent[0]!.context, { via: "pass_on_user_reaction", agent_note: "priority chips on Issues" });
});

test("user_said on one of your own tools is noticed in any call, and named in the instructions", async () => {
  const server = new McpServer({ name: "acme", version: "1.0.0" });
  wrapMcpServer(server, { product: "Acme", context: ({ args }) => ({ user: "maya", workItem: { type: "canvas", id: String(args.canvas_id) } }) });
  server.registerTool(
    "save_decision",
    { inputSchema: { canvas_id: z.string(), decision: z.string(), ...userReactionFields } },
    async () => ({ content: [{ type: "text" as const, text: "saved" }] }),
  );
  const client = await connect(server);
  assert.match(client.getInstructions() ?? "", /fill user_said and user_reaction on save_decision/);
  await client.callTool({ name: "save_decision", arguments: { canvas_id: "c2", decision: "Chips hug their text", user_said: "we should add filters and grouping" } });
  await client.callTool({ name: "save_decision", arguments: { canvas_id: "c2", decision: "Brief" } });
  await flush();
  assert.equal(sent.length, 1, "only the call that carried the person's words");
  assert.equal(sent[0]!.kind, "change_request", "a request by default, not a complaint");
  assert.equal(sent[0]!.sentiment, "neutral");
  assert.deepEqual(sent[0]!.work_item, { type: "canvas", id: "c2" });
  assert.equal(sent[0]!.context?.via, "save_decision");
});

/* ---------- checkMcpServer ---------- */

test("checkMcpServer passes a server set up with the one line, and restores the real client", async () => {
  const real = getClient();
  const result = await checkMcpServer(() => demoServer(true), { failingCall: { tool: "insert_instance", args: { canvas_id: "c1", name: "PricingCard" } } });
  assert.ok(result.ok, formatChecks(result));
  assert.deepEqual(
    result.checks.map((c) => [c.name, c.status]),
    [
      ["instructions", "pass"],
      ["report tool", "pass"],
      ["person's words", "pass"],
      ["report sent", "pass"],
      ["breadcrumbs", "pass"],
      ["person's words sent", "pass"],
      ["who", "pass"],
    ],
  );
  assert.equal(getClient(), real, "the stand-in Glassray is gone afterwards");
  assert.equal(sent.length, 0, "nothing reached the real Glassray");
});

test("checkMcpServer fails a bare server and says what to do", async () => {
  const result = await checkMcpServer(() => {
    const server = new McpServer({ name: "bare", version: "1.0.0" });
    server.registerTool("get_doc", { inputSchema: { id: z.string() } }, async () => ({ isError: true, content: [{ type: "text" as const, text: "no such doc" }] }));
    return server;
  });
  assert.equal(result.ok, false);
  const text = formatChecks(result);
  assert.match(text, /✗ instructions: .*wrapMcpServer/);
  assert.match(text, /✗ report tool: No report_issue tool/);
  assert.match(text, /✗ person's words: Nothing passes on what the person says/);
});

test("a product's own report_issue is its own: it keeps breadcrumbs, and its idea tool is named", async () => {
  const server = new McpServer({ name: "acme", version: "1.0.0" });
  wrapMcpServer(server, { product: "Acme", reportTools: false, ownReportTool: "report_issue", ownIdeaTool: "share_feedback", context: () => ({ user: "maya" }) });
  server.registerTool("report_issue", { inputSchema: { message: z.string() } }, async ({ message }) => {
    signal({ source: "agent", kind: "tool_failure", message });
    return { content: [{ type: "text" as const, text: "thanks" }] };
  });
  server.registerTool("get_canvas", { inputSchema: { canvas_id: z.string() } }, async () => ({ isError: true, content: [{ type: "text" as const, text: "no canvas" }] }));
  const client = await connect(server);
  assert.match(client.getInstructions() ?? "", /Ideas for making Acme better.*share_feedback/);
  await client.callTool({ name: "get_canvas", arguments: { canvas_id: "x" } });
  await client.callTool({ name: "report_issue", arguments: { message: "get_canvas failed" } });
  await flush();
  const recent = sent[0]!.context?.recent_tool_calls as { tool: string }[];
  assert.deepEqual(recent.map((c) => c.tool), ["get_canvas"]);
});

test("no key: quietly off; a key that is not a Glassray key: one warning", async () => {
  const errors: string[] = [];
  init({ apiKey: "", onError: (e) => errors.push(e.message) });
  assert.equal(errors.length, 0);
  init({ apiKey: "sk-not-ours", onError: (e) => errors.push(e.message) });
  assert.match(errors[0] ?? "", /does not look like a Glassray key/);
});

test("a report carries what was needed, what was tried, and what would fix it", async () => {
  const client = await connect(demoServer(true));
  await client.callTool({ name: "insert_instance", arguments: { canvas_id: "c7", name: "PricingCard" } });
  sent = [];
  await client.callTool({
    name: "report_issue",
    arguments: {
      kind: "missing_capability",
      needed: "a way to find a component by name",
      tried: "list_components, then matched 214 names by eye",
      suggestion: "give list_components a query parameter",
      tool: "list_components",
    },
  });
  await flush();
  const report = sent.find((s) => s.source === "agent")!;
  assert.equal(report.message, "a way to find a component by name", "the gap is the headline");
  assert.equal(report.context?.tried, "list_components, then matched 214 names by eye");
  assert.equal(report.context?.suggestion, "give list_components a query parameter");
  assert.equal(report.tool, "list_components");
});

test("the triggers are moments an agent can catch itself in, not a taxonomy", async () => {
  const client = await connect(demoServer(true));
  const d = (await client.listTools()).tools.find((t) => t.name === "report_issue")!.description ?? "";
  for (const moment of [/looked for a tool that does not exist/i, /had to approximate, guess, or do it by hand/i, /gave you less than you asked for/i])
    assert.match(d, moment);
  const needed = (await client.listTools()).tools.find((t) => t.name === "report_issue")!.inputSchema.required as string[];
  assert.deepEqual([...needed].sort(), ["kind", "needed", "tried"], "the three questions are required, not requested");
});

/*
 * bin/glassray-signals.mjs is a script, so its functions are hoisted and its constants are not.
 * When it started work near the top, a person at a real terminal crashed at the hand-over with
 * "Cannot access 'AGENTS' before initialization", after sign-in had already worked. Without a
 * terminal the lookup is skipped, so no test that runs the script can see it. This reads it instead.
 */
test("the setup command starts only after every constant it reads is defined", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../bin/glassray-signals.mjs", import.meta.url), "utf8");
  const lines = source.split("\n");
  const lastConst = lines.findLastIndex((l) => /^const [A-Z_a-z]+ = /.test(l));
  const firstStart = lines.findIndex((l) => /^ {2}(await )?(done|login)\(\)/.test(l));
  assert.ok(lastConst > 0 && firstStart > 0, "found the constants and the entry point");
  assert.ok(firstStart > lastConst, `the script starts on line ${firstStart + 1}, before the constant on line ${lastConst + 1}`);
});

/*
 * While a coding agent wires Glassray in, the setup command tells the setup page what is true in the
 * repo. These are the facts it reads, from the files themselves and never from what the agent says.
 */
test("the setup command reads how far the repo has got, and what is being worked on", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { repoFacts } = (await import(new URL("../bin/progress.mjs", import.meta.url).href)) as {
    repoFacts: (cwd: string) => { steps: { id: string; done: boolean; file?: string }[]; lastFile?: string };
  };
  const done = (cwd: string) => Object.fromEntries(repoFacts(cwd).steps.map((s) => [s.id, s.file ?? false]));

  const repo = mkdtempSync(join(tmpdir(), "gr-facts-"));
  try {
    mkdirSync(join(repo, "server"));
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "acme", dependencies: { zod: "^4" } }));
    writeFileSync(join(repo, "server/mcp.ts"), "export const server = 1;\n");
    assert.deepEqual(done(repo), { sdk: false, init: false, mcp: false, signals: false, check: false }, "nothing yet, in a folder that is not a git repo");

    /* the agent adds the dependency, then wraps the server and starts the SDK */
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "acme", dependencies: { "@glassray/signals": "^0.3.0" } }));
    writeFileSync(join(repo, "server/mcp.ts"), 'import { init } from "@glassray/signals";\nimport { wrapMcpServer } from "@glassray/signals/mcp";\ninit();\nwrapMcpServer(server, { product: "Acme" });\n');
    assert.deepEqual(done(repo), { sdk: "package.json", init: "server/mcp.ts", mcp: "server/mcp.ts", signals: false, check: false });

    /* a test that calls init() and signal() says nothing about the product itself */
    writeFileSync(join(repo, "tests/glassray.test.ts"), 'import { init, signal } from "@glassray/signals";\nimport { checkMcpServer } from "@glassray/signals/testing";\ninit();\nsignal({ source: "user", kind: "undo" });\nawait checkMcpServer(build);\n');
    assert.deepEqual(done(repo), { sdk: "package.json", init: "server/mcp.ts", mcp: "server/mcp.ts", signals: false, check: "tests/glassray.test.ts" });

    writeFileSync(join(repo, "server/undo.ts"), 'import { signal } from "@glassray/signals";\nexport const undo = () => signal({ source: "user", kind: "undo" });\n');
    assert.equal(done(repo).signals, "server/undo.ts");

    /* in a git repo it also says which file changed last, leaving out the key and the lockfile */
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    writeFileSync(join(repo, ".env"), "GLASSRAY_API_KEY=gr_secret\n");
    writeFileSync(join(repo, "bun.lock"), "{}");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(repo, "tests/glassray.test.ts"), later, later);
    utimesSync(join(repo, ".env"), new Date(Date.now() + 9000), new Date(Date.now() + 9000));
    const facts = repoFacts(repo);
    assert.equal(facts.lastFile, "tests/glassray.test.ts", "the file being worked on, never .env");
    assert.equal(facts.steps.every((s) => s.done), true);
    assert.ok(!JSON.stringify(facts).includes("gr_secret"), "paths and yes/no only, never what a file holds");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
