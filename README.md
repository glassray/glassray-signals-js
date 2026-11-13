<div align="center" id="top">

<img src="docs/banner.png" alt="@glassray/signals" width="900">

[![Built by Glassray](https://img.shields.io/badge/Built%20by-Glassray-828fff?style=for-the-badge)](https://glassray.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-2563eb?style=for-the-badge)](LICENSE)

[![npm](https://img.shields.io/npm/v/@glassray/signals.svg)](https://www.npmjs.com/package/@glassray/signals)
[![CI](https://github.com/glassray/glassray-signals-js/actions/workflows/ci.yml/badge.svg)](https://github.com/glassray/glassray-signals-js/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933?style=flat&logo=nodedotjs&logoColor=white)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-0-4cb782?style=flat)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server%20wrapper-6f42c1?style=flat)](#-mcp-servers-in-one-line)
[![Agent Skills](https://img.shields.io/badge/Agent%20Skills-SKILL.md-blueviolet?style=flat)](https://agentskills.io)

</div>

# @glassray/signals

**Send Glassray what people do with your AI agent's work, and what the agent says about its own.
One call for an MCP server.**

## Why

- Agents work around broken tools and say nothing. We watched one hit four problems in a session,
  work around all four and report none. Its reason: "the failures were self-healing, so none of them
  felt like getting stuck."
- People complain in the agent's chat, where your product never sees it.
- A tool that politely asks for reports gets skipped. Another agent, on a server that asked, left out
  three: "I invented a workaround and moved on instead of taking the extra call."

## What it does

`wrapMcpServer(server, { product })` gives your MCP server:

- `report_issue` and `share_feedback`, which agents call as they work. `report_issue` has required
  fields: what you needed, what you tried and, optionally, what would fix it.
- `pass_on_user_reaction`, which carries the person's exact words from the agent's chat.
- A paragraph in the server's instructions telling agents to use these without asking first, and to
  report even when they recover.
- The last few tool calls attached to every report, so it arrives with what led to it.

`checkMcpServer` then proves it in your tests: it plays a scripted session against your server and
checks what would reach Glassray. Outside MCP, `signal()` sends anything from your own code, such as
an undo, a regenerate or a rating.

Calls return at once and never throw, signals are sent in the background, and there are no runtime
dependencies.

## 🚀 Quickstart

**1. Install.** No runtime dependencies, Node 18 or later:

```sh
npm install @glassray/signals
```

**2. Get a key** in the Glassray dashboard, under Settings → API keys. A signals key can only send.

**3. Start it** once, wherever your process starts:

```ts
import { init } from "@glassray/signals";

init(); // reads GLASSRAY_API_KEY and GLASSRAY_ENDPOINT
```

Without a key every call does nothing, so the calls can stay in your code in every environment.

**4. Send what happens:**

```ts
import { signal } from "@glassray/signals";

// a person threw away what the agent made
signal({ source: "user", kind: "undo", work_item: { type: "canvas", id: canvasId }, refs: { user: userId } });

// the agent says what went wrong
signal({ source: "agent", kind: "tool_failure", tool: "insert_instance", message: "PricingCard not found; drew rectangles instead" });
```

`work_item` is your own unit of work, such as a canvas, a report or a ticket. It is how Glassray
links what a person did to what the agent said while doing it.

Kinds for signals from users are free text, and the well-known ones get a sentiment on arrival:
`regenerate`, `correction`, `undo`, `replaced_agent_work`, `needs_review`, `thumbs_down`, `export`,
`ready_for_dev` and others. Signals from agents always carry a `message`, and `AGENT_KINDS` lists
the well-known ones. Kind and source are independent.

### Say who and what once

Signals sent inside `withContext` inherit its user, work item, session, trace and agent. Explicit
fields on a signal still win.

```ts
import { withContext, setContext } from "@glassray/signals";

setContext({ agent: { name: "report-writer", version: "3.9" } }); // for the whole process

await withContext({ user: userId, workItem: { type: "report", id: reportId } }, () => handleRequest());
```

Where the runtime exposes `node:async_hooks` through `process.getBuiltinModule` it uses
`AsyncLocalStorage`, so the context follows async work. Elsewhere it falls back to a synchronous
stack, which is right for synchronous code and best effort across an `await`.

## 🔌 MCP servers in one line

Call `wrapMcpServer` right after creating the server and before registering any tools, because it
wraps `registerTool`:

```ts
import { wrapMcpServer } from "@glassray/signals/mcp";

const server = new McpServer({ name: "acme", version: "1.0.0" });
wrapMcpServer(server, {
  product: "Acme",
  context: ({ args }) => ({ user: currentUser.id, workItem: args.doc_id && { type: "doc", id: String(args.doc_id) } }),
});
```

Your own instructions stay first; ours are appended. Every tool call runs in a context holding the
person, the work item and the agent client from the MCP handshake, so a bare `signal()` inside a tool
is filled in.

Needs `@modelcontextprotocol/sdk` and `zod`, which an MCP server already has. Both are optional
peers, so the core of the package installs without them.

### If your server already has a report tool

Keep it. Turn ours off, name yours, and send a signal from inside it:

```ts
wrapMcpServer(server, { product: "Acme", reportTools: false, ownReportTool: "report_issue" });
```

To let the person's words travel on a tool of your own, add our fields to it. Any call that carries
them is sent as a signal from the user:

```ts
import { userReactionFields } from "@glassray/signals/mcp";
server.registerTool("save_decision", { inputSchema: { doc_id, decision, ...userReactionFields } }, handler);
```

If you set the server's instructions somewhere else, such as a guide tool, `glassrayInstructions({ product })`
returns the same paragraph to append.

This package sends no traces. If you trace, with `@glassray/tracing`, OpenTelemetry or anything
else, put the trace id in the context with `withContext({ trace: traceId }, ...)` inside your
tracing wrapper, and Glassray links each signal to the exact spans.

## 🧪 Check it in your tests

```ts
import { checkMcpServer, formatChecks } from "@glassray/signals/testing";

const result = await checkMcpServer(() => buildServer(testUser), {
  failingCall: { tool: "get_doc", args: { doc_id: "missing" } },
});
assert.ok(result.ok, formatChecks(result));
```

It connects to your server in memory, plays a short scripted session against a stand-in Glassray (a
tool fails, the agent reports it, the person complains), and checks what an agent would read and
what would be sent. Nothing leaves your machine.

The failures name what is missing and how to fix each one, for example: "Nothing passes on
what the person says in the agent's chat, which is where most reactions happen. Leave reactionTool
on in wrapMcpServer, or add userReactionFields to your own tools."

What it cannot tell you is whether a real agent will follow the instructions. That needs a live run
with a model, and it has gone both ways: of three sessions we have watched on a wired-up server,
one reported without being asked.

## 🤖 Let your coding agent set it up

```sh
npx @glassray/signals setup
```

sets Glassray up from start to finish. It copies the `glassray-setup` skill into `.claude/skills/`
(or any folder with `--to`), then opens your browser to sign in: check the code there matches the one
in your terminal and pick an organization. It writes a signals key to `.env`, sends a test signal, and
hands over to your coding agent (Claude Code, Codex or Cursor, whichever is installed) in the same
terminal. The agent follows the skill: it finds your unit of work, wraps the MCP server, hooks what
people do to the agent's work, proves it with `checkMcpServer` and one test per hook, and sends one
real signal. Nobody copies a key by hand.

Options: `--endpoint` for your own Glassray server, `--env-file` for another file, `--agent claude`,
`codex`, `cursor` or `none`, and `--no-login` to skip signing in. Run by an agent or in CI, it prints
the prompt instead of starting another agent.

## ⚙️ Options for `init`

| Option | Default | |
| --- | --- | --- |
| `apiKey` | `GLASSRAY_API_KEY` | Without a valid key nothing is sent. |
| `endpoint` | `GLASSRAY_ENDPOINT`, then `https://app.glassray.ai` | |
| `enabled` | `true` | Turn sending off without removing calls. |
| `beforeSend` | | Edit a signal, or return `null` to drop it. Runs after context is filled in. |
| `sampleRate` | `1` | Share of signals kept. |
| `onError` | one `console.warn` per minute | Pass `() => {}` for silence. |
| `maxQueue` | `2000` | Signals held while Glassray is unreachable; further ones are dropped. |

Call `await flush()` before a short-lived process exits, such as a script or a serverless function.

## 📦 What's in the repository

| Path | What it holds |
| --- | --- |
| [src/index.ts](src/index.ts) | `init`, `signal`, `flush`, the context, the client |
| [src/mcp/](src/mcp/) | `wrapMcpServer`, the report and reaction tools, the instructions paragraph, breadcrumbs |
| [src/testing/](src/testing/) | `checkMcpServer` and `formatChecks` |
| [skills/glassray-setup/](skills/glassray-setup/) | The skill a coding agent reads to wire this up and prove it |
| [scripts/smoke.mjs](scripts/smoke.mjs) | Loads the built package and sends one signal, run on every Node version in CI |
| [SECURITY.md](SECURITY.md) | What this sends and where, the install script, and how to report a hole |

## 🤝 Contributing

This package is developed in Glassray's monorepo and mirrored here, so a pull request against this
repository is overwritten by the next sync. Open an issue, and see [CONTRIBUTING.md](CONTRIBUTING.md).

MIT licensed, see [LICENSE](LICENSE).

<p align="right"><a href="#top">⬆️ Back to top</a></p>
