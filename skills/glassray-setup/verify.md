# Verify

## First pass

You are done with the first pass when these pass. If one can't run, say which and why.

### 1. The repo's own checks

Run the repo's typecheck and lint, and the tests for the files you changed. Run the full suite only if it takes a couple of minutes or less; otherwise leave it to the repo's CI and say so.

### 2. The MCP server, with checkMcpServer

Add one test next to the server's other tests. It must build the server the same way production does:

```ts
import { checkMcpServer, formatChecks } from "@glassray/signals/testing";

it("Glassray hears from this MCP server", async () => {
  const result = await checkMcpServer(() => buildServer(/* a test user */), {
    failingCall: { tool: "get_doc", args: { doc_id: "no-such-doc" } }, // a call that fails on purpose
    // with the product's own report tool: reportTool: "report_issue", reportArgs: { category: "bug" }
  });
  expect(result.ok, formatChecks(result)).toBe(true);
});
```

It runs in memory against a stand-in Glassray, so nothing leaves the machine. Fix every ✗. Fix each `!` too, unless you can explain why it doesn't apply.

If the product has no MCP server, skip this and say so.

### 3. Don't send a signal yourself

The setup page marks setup done when the product sends its first real signal. That happens the first time someone uses the product with the key in `.env`. Don't start the app, sign up users, or write a script to make it happen: a signal from a test run or a script is not real use, and it lands in the person's data. Tell the person what to do instead (see the report).

### 4. Report back

End your reply with:
- the unit of work and how the person is identified;
- a table of every hook you added: file and line, kind, when it fires;
- what `checkMcpServer` printed;
- the hooks you left for the second pass, and anything you can't hook, and why. For example: "the product can't tell agent edits from human edits";
- one line telling the person how to send the first real signal: start the app as they usually do and use it once (for an MCP server, have an agent make one tool call). The setup page ticks when it arrives.

## Second pass

Only when the person asks.

### Signals from users, one test per hook

For each `signal()` you added, write a test. Do the person's action through the product's real code path, then check that exactly one signal went out, with the right `kind`, `work_item` and `refs.user`. Capture what is sent by starting the SDK with a fake fetch:

```ts
const sent = [];
init({ apiKey: "gr_test", endpoint: "https://glassray.test", onError: () => {},
  fetch: async (_url, init) => { sent.push(...JSON.parse(String(init.body)).signals); return new Response("{}", { status: 202 }); } });
// ...do the action...
await flush();
```

Also test the negative case: the same action on work no agent touched sends nothing. If every instance of an action is about agent work (say, retrying an agent's task), test the nearest "nothing to signal" case instead and say so.

If the product's tests start a real server process, the fake fetch above can't see it. Run a small stand-in Glassray instead: a local HTTP server that records POSTs to `/v1/signals`. Point `GLASSRAY_ENDPOINT` at it, and set `GLASSRAY_API_KEY=gr_test` for that server process.

### Check the data Glassray received

Once real signals have arrived, check they are complete, not only that they arrived. Glassray's MCP server has a `check_setup` tool: it grades what the product sent (a work item and person on every signal, both sources linked, sentiment, tool names) and says what to change for each gap. Use the server at the `GLASSRAY_ENDPOINT` in `.env`, at `<GLASSRAY_ENDPOINT>/mcp`. If the person has several servers named glassray, check you are calling that one. Without it, say so in your report: the person can connect it and ask you again.
