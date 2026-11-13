# @glassray/signals

Send **signals** about your AI agent's work to [Glassray](https://glassray.ai). A signal has a **source**:

- `user`: something a person did or said about the agent's work: an undo, a regenerate, an edit, a rating, a reply.
- `agent`: something the agent said about its own work: a tool that failed, input that was cut off, a guess it made.

Glassray links the two, investigates when people are unhappy, and groups the causes into issues your coding agent can fix.

No dependencies. Calls return at once and never throw: signals are batched and sent in the background, and a Glassray outage never breaks your product.

## Install and set up

```sh
npm install @glassray/signals
```

```ts
import { init } from "@glassray/signals";

init(); // reads GLASSRAY_API_KEY (Glassray → Settings → API keys) and GLASSRAY_ENDPOINT
```

Before `init`, or without a key, every call does nothing, so the calls can stay in your code everywhere.

## Send signals

```ts
import { signal } from "@glassray/signals";

// a person threw away what the agent made
signal({ source: "user", kind: "undo", work_item: { type: "canvas", id: canvasId }, refs: { user: userId } });

// the agent says what went wrong
signal({ source: "agent", kind: "tool_failure", tool: "insert_instance", message: "PricingCard not found; drew rectangles instead" });
```

`work_item` is your own unit of work (a canvas, a report, a ticket): it is how Glassray links what people did to what the agent said. Kinds for signals from users are free text; well-known ones (`regenerate`, `correction`, `undo`, `replaced_agent_work`, `needs_review`, `thumbs_down`, `export`, `ready_for_dev`, …) get a sentiment automatically. Signals from agents always carry a `message`; `AGENT_KINDS` are the well-known kinds. Kind and source are independent.

## Context: say who and what once

Signals sent inside `withContext` get its user, work item, session, trace and agent filled in. Explicit fields always win.

```ts
import { withContext, setContext } from "@glassray/signals";

setContext({ agent: { name: "report-writer", version: "3.9" } }); // whole process

await withContext({ user: userId, workItem: { type: "report", id: reportId } }, () => handleRequest());
```

It follows async work (AsyncLocalStorage on Node).

## MCP servers

One line, right after creating the server and before registering tools:

```ts
import { wrapMcpServer } from "@glassray/signals/mcp";

const server = new McpServer({ name: "acme", version: "1.0.0" });
wrapMcpServer(server, {
  product: "Acme",
  context: ({ args }) => ({ user: currentUser.id, workItem: args.doc_id && { type: "doc", id: String(args.doc_id) } }),
});
// ...then register your tools as usual
```

It then:

- adds three tools: `report_issue` and `share_feedback` (what the agent says about your product), and `pass_on_user_reaction` (what the person said about the agent's work in its chat, word for word, which your product never sees otherwise);
- `report_issue` asks three questions as required fields rather than as prose: **what you needed**, **what you tried**, and optionally **what would fix it** — agents offer a fix most of the time when there is somewhere to put one, often a whole tool signature;
- adds a short paragraph to the server's instructions telling agents to use them as they work, without asking the person first (agents otherwise tend to ask, and often never report). Your own instructions stay first;
- runs every tool call in a context (person, work item, and the agent client from the MCP handshake), so `signal()` inside a tool fills them in;
- leaves a breadcrumb per call (tool, ok or failed, error, duration). Signals from agents carry the last few, so a report arrives with the calls that led to it — the record of what happened, next to the agent's own account of it.

**If your server already has a report tool,** keep it: `wrapMcpServer(server, { reportTools: false, ownReportTool: "report_issue" })`, and send `signal({ source: "agent", ... })` from it. To let the person's words travel on your own tools, add our fields; any call that carries them is sent as a signal from the user:

```ts
import { userReactionFields } from "@glassray/signals/mcp";
server.registerTool("save_decision", { inputSchema: { doc_id, decision, ...userReactionFields } }, handler);
```

Set your own instructions elsewhere (a guide tool)? `glassrayInstructions({ product })` returns the same paragraph.

The SDK sends no traces. If you trace (with `@glassray/tracing`, OpenTelemetry or anything else), put the trace id in the context with `withContext({ trace: traceId }, ...)` inside your tracing wrapper, and Glassray links each signal to the exact spans.

Needs `@modelcontextprotocol/sdk` and `zod`, which an MCP server has already.

## Check it in your tests

```ts
import { checkMcpServer, formatChecks } from "@glassray/signals/testing";

const result = await checkMcpServer(() => buildServer(testUser), { failingCall: { tool: "get_doc", args: { doc_id: "missing" } } });
assert.ok(result.ok, formatChecks(result));
```

It plays a short session against a stand-in Glassray (a tool fails, the agent reports it, the person complains) and checks what agents read and what would be sent. Nothing leaves your machine.

## Let your coding agent set it up

```sh
npx @glassray/signals setup
```

copies the `glassray-setup` skill into `.claude/skills/` (or `--to` any folder). Then ask Claude Code, Cursor or Codex: *"Set up Glassray in this repo using the glassray-setup skill."* The skill walks it through finding your unit of work, wrapping the MCP server, hooking what people do to the agent's work (undo, regenerate, edit, delete, reply, rating), and proving it with `checkMcpServer` and one test per hook.

## Options for `init`

| Option | Default | |
|---|---|---|
| `apiKey` | `GLASSRAY_API_KEY` | Without a valid key nothing is sent. |
| `endpoint` | `GLASSRAY_ENDPOINT`, then `https://app.glassray.ai` | |
| `enabled` | `true` | Turn sending off without removing calls. |
| `beforeSend` | | Edit a signal, or return `null` to drop it. Runs after context is filled in. |
| `sampleRate` | `1` | Share of signals kept. |
| `onError` | one `console.warn` per minute | Pass `() => {}` for silence. |
| `maxQueue` | `2000` | Signals held while Glassray is unreachable; more are dropped. |

Call `await flush()` before a short-lived process (a script, a serverless function) exits.

MIT licensed.
