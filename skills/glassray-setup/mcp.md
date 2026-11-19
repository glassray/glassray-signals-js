# MCP servers

## The SDK, all of it that setup uses

This is the whole API you need. Don't read the SDK's code in `node_modules`; if something here is unclear, its `.d.ts` files say the same.

```ts
import { init, signal, withContext, flush } from "@glassray/signals";
import { wrapMcpServer, userReactionFields, glassrayInstructions } from "@glassray/signals/mcp";
import { checkMcpServer, formatChecks } from "@glassray/signals/testing";
```

- `init({ apiKey?, endpoint?, enabled?, onError?, fetch? })`: once at startup. Reads `GLASSRAY_API_KEY` and `GLASSRAY_ENDPOINT` when not passed. With no key, everything quietly does nothing.
- `signal({ source, kind, message?, work_item?, refs?, tool?, context?, sentiment?, value? })`: returns at once, never throws. `source` is `"user"` or `"agent"`; `message` is required for `"agent"`. `work_item` is `{ type, id }`. `refs` is `{ user?, session?, trace? }`.
- `withContext({ user?, workItem?, session?, trace?, agent?: { name?, client? }, extra? }, fn)`: runs `fn` with these filled in on every `signal()` inside it.
- `flush()`: waits for queued signals. For tests and short scripts only.
- `wrapMcpServer(server, options)`. The options, all optional:

  | Option | Default | What it does |
  |---|---|---|
  | `product` | the server's name | The name agents read in the paragraph and tool descriptions |
  | `context` | none | `({ tool, args, client }) => ({ user, workItem, agent })` for each tool call; may be async |
  | `reportTools` | `true` | Adds `report_issue` and `share_feedback`. `false` when the product has its own |
  | `ownReportTool`, `ownIdeaTool` | none | The product's own tool names, when `reportTools` is `false` |
  | `reactionTool` | `true` | Adds `pass_on_user_reaction` |
  | `instructions` | `true` | Adds the paragraph after the server's own instructions |
  | `toolCalls` | `false` | Also sends each tool call to Glassray: the tool, how long it took, whether it failed. No arguments or results. Set it `true` (see below) |

- `userReactionFields`: zod fields (`user_said`, `user_reaction`) to spread into a tool's `inputSchema`.
- `glassrayInstructions({ product, reportTool?, ideaTool? })`: the paragraph as text, to place yourself.
- `checkMcpServer(makeServer, { failingCall?, reportTool?, reportArgs?, reactionTool? })` returns `{ ok, checks, signals }`. It plays a short session in memory against a stand-in Glassray, so nothing leaves the machine. It checks six things: the instructions, the report tool, the person's words, a failing call, that the report was sent, and that tool calls reach Glassray. `formatChecks(result)` prints them.

## The one line

Right after creating the server, **before any `registerTool`**:

```ts
import { init } from "@glassray/signals";
import { wrapMcpServer } from "@glassray/signals/mcp";

init();
const server = new McpServer({ name: "acme", version }, { instructions: OWN_INSTRUCTIONS });
wrapMcpServer(server, {
  product: "Acme",
  toolCalls: true,
  context: ({ args }) => ({
    user: currentUserId, // whoever the agent works for on this connection
    ...(typeof args.doc_id === "string" ? { workItem: { type: "doc", id: args.doc_id } } : {}),
  }),
});
// ...register tools as before
```

This:
- adds three tools: `report_issue`, `share_feedback` and `pass_on_user_reaction`;
- adds a short paragraph to the server's instructions. It tells agents to report as they work and to pass on the person's words, without asking first. The server's own instructions stay first.
- runs every tool call with the person and work item filled in, so `signal()` calls inside tools need no ids;
- remembers the last tool calls, so an agent's report arrives with the calls that led to it;
- with `toolCalls: true`, sends every tool call to Glassray, grouped into one session per agent run. This fills Glassray's Activity, Sessions and Tools pages. Without it they stay empty, and the person wonders why.

`toolCalls` also adds two optional arguments to each tool, `llm_model` and `intent`, so agents can say which model they are and what they are trying to do. The SDK removes them before your handler runs. If the product has a test that pins its tools' input schemas exactly, allow for these two. Don't drop `toolCalls` to make that test pass.

`context` is called for every tool call. Read the work item's id from the tool's arguments: find the argument name the product uses (`canvas_id`, `doc_id`, `project`…). If several tools use different names, handle each. Who the person is usually comes from the auth on the connection: the same place the tools get it.

`wrapMcpServer` wraps `registerTool`, so tools registered before it are missed. If the product already wraps `registerTool` itself (to load data, check access, trace), order matters. Wrappers added after `wrapMcpServer` run first. So if `context` reads data that another wrapper loads, call `wrapMcpServer` after that wrapper.

**Stateless servers** (a new server per HTTP request): wrap each new server; that's fine. But only the first request sees the MCP handshake, so the agent client's name (`claude-code`, `cursor`) is missing on later ones. If the product records the client elsewhere (its session or token), return it from `context` as `agent: { client }`.

**Low-level `Server`** (from `@modelcontextprotocol/sdk/server/index.js`, not `McpServer`): `wrapMcpServer` can't wrap it. Instead:
- put `glassrayInstructions({ product })` in its `instructions`;
- call `withContext({ user, workItem }, ...)` around the tool dispatch;
- send `signal()` from its own report tool.

If it only forwards to tools that are already hooked elsewhere (an in-app agent's tool runner), hook that runner instead.

## The product already has its own report tool

Keep theirs. Don't add a second one:

```ts
wrapMcpServer(server, { product: "Acme", reportTools: false, ownReportTool: "report_issue", ownIdeaTool: "share_feedback", toolCalls: true, context });
```

Also add the no-permission sentence (see SKILL.md, Rules) to that tool's description.

Then, in that tool's handler, also send the report to Glassray:

```ts
signal({ source: "agent", kind: "tool_failure", tool: args.tool, message: args.message });
```

Map their categories to kinds: errors and bugs to `tool_failure`; unclear docs to `confusing`; missing features to `missing_capability`; ideas to `idea`.

Agents fill that message with whatever its description asks for. If it says only "the error" or "what went wrong", agents paste the bare error ("canvas not found"), which tells a person little. Make the description ask for what the agent was trying to do and what happened instead, written for someone who did not see the session.

If their tool takes one freeform message, consider adding the fields ours uses — `needed`, `tried` and an optional `suggestion`. A required field gets answered; "be specific" in a description gets skipped. Put `tried` and `suggestion` in the signal's `context`.

Leave `pass_on_user_reaction` on (the default). If the product has tools where a person's reaction naturally belongs (its own report tool, or a "save decision" or "record feedback" tool), also add our fields to them. `wrapMcpServer` notices the fields in any call and sends the person's words:

```ts
import { userReactionFields } from "@glassray/signals/mcp";
server.registerTool("save_decision", { inputSchema: { canvas_id, decision, ...userReactionFields } }, handler);
```

Don't send those words yourself from the handler; that would send them twice.

## Instructions get cut

Clients read only the start of a server's instructions: ChatGPT about 512 characters, older Claude Code 2,048, current Claude Code 4,096. `wrapMcpServer` puts its paragraph after the product's own text, so the product's text is never what gets cut, but the paragraph may be. If the product has a test that limits the length of its instructions, keep that limit on the product's own text and allow for the paragraph after it. Don't drop the test.

## The product sets instructions elsewhere

Some products tell agents how to work through a guide tool or a docs resource, not the server's `instructions`. Leave the automatic paragraph on, and also add the same text where agents really read:

```ts
import { glassrayInstructions } from "@glassray/signals/mcp";
const text = glassrayInstructions({ product: "Acme", reportTool: "report_issue", ideaTool: "share_feedback" });
```

## The server already traces tool calls

If the product already sends its tool calls to Glassray as OpenTelemetry traces (with `@glassray/tracing` or its own exporter pointed at Glassray), leave `toolCalls` off, or every call arrives twice. Wrap that tracing around the handler *after* `wrapMcpServer`, and inside the span put the trace id in the context so signals link to it: `withContext({ trace: traceId }, run)`.

If it traces to somewhere else (Datadog, Honeycomb, Langfuse), keep that as it is and still set `toolCalls: true`.
