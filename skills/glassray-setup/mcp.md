# MCP servers

## The one line

Right after creating the server, **before any `registerTool`**:

```ts
import { init } from "@glassray/signals";
import { wrapMcpServer } from "@glassray/signals/mcp";

init();
const server = new McpServer({ name: "acme", version }, { instructions: OWN_INSTRUCTIONS });
wrapMcpServer(server, {
  product: "Acme",
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
- remembers the last tool calls, so an agent's report arrives with the calls that led to it.

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
wrapMcpServer(server, { product: "Acme", reportTools: false, ownReportTool: "report_issue", ownIdeaTool: "share_feedback", context });
```

Also add the no-permission sentence (see SKILL.md, Rules) to that tool's description.

Then, in that tool's handler, also send the report to Glassray:

```ts
signal({ source: "agent", kind: "tool_failure", tool: args.tool, message: args.message });
```

Map their categories to kinds: errors and bugs to `tool_failure`; unclear docs to `confusing`; missing features to `missing_capability`; ideas to `idea`.

If their tool takes one freeform message, consider adding the fields ours uses — `needed`, `tried` and an optional `suggestion`. A required field gets answered; "be specific" in a description gets skipped. Put `tried` and `suggestion` in the signal's `context`.

Leave `pass_on_user_reaction` on (the default). If the product has tools where a person's reaction naturally belongs (its own report tool, or a "save decision" or "record feedback" tool), also add our fields to them. `wrapMcpServer` notices the fields in any call and sends the person's words:

```ts
import { userReactionFields } from "@glassray/signals/mcp";
server.registerTool("save_decision", { inputSchema: { canvas_id, decision, ...userReactionFields } }, handler);
```

Don't send those words yourself from the handler; that would send them twice.

## The product sets instructions elsewhere

Some products tell agents how to work through a guide tool or a docs resource, not the server's `instructions`. Leave the automatic paragraph on, and also add the same text where agents really read:

```ts
import { glassrayInstructions } from "@glassray/signals/mcp";
const text = glassrayInstructions({ product: "Acme", reportTool: "report_issue", ideaTool: "share_feedback" });
```

## The server traces tool calls

`@glassray/signals` sends no traces. If the product traces tool calls (with `@glassray/tracing`, OpenTelemetry or anything else), wrap the tracing around the handler *after* `wrapMcpServer`. Inside the span, put the trace id in the context so signals link to it: `withContext({ trace: traceId }, run)`.
