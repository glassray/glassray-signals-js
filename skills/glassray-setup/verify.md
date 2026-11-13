# Verify

You are not done until these pass. If one can't run, say which and why.

## 1. The repo's own checks

Run the repo's typecheck, lint and tests. They must be as green as before you started.

## 2. The MCP server, with checkMcpServer

Add a test next to the server's other tests. It must build the server the same way production does:

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

It plays a short session against a stand-in Glassray, so nothing leaves the machine. Fix every ✗. Fix each `!` too, unless you can explain why it doesn't apply.

## 3. Signals from users, one test per hook

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

## 4. A real signal, if a key is available

If `GLASSRAY_API_KEY` is set (in the environment or `.env`), run the app and do one real action that sends a signal through the code you added, with the real key and endpoint. Glassray's setup page is waiting for this one: it marks setup done when a signal arrives on any work item other than `setup:test`. If the app can't run here, send one through the module you added from a short script instead, and say so.

Then check the data is complete, not only that it arrived. If the Glassray MCP server is connected (`claude mcp add --transport http glassray <GLASSRAY_ENDPOINT>/mcp`), call its `check_setup` tool: it grades what the product sent, such as a work item and person on every signal, both sources linked, sentiment and tool names, and says what to change for each gap. Fix what it flags and run it again. Otherwise the same check is on the setup page in the Glassray dashboard.

## 5. Report back

End your reply with:
- the unit of work and how the person is identified;
- a table of every hook you added: file and line, kind, when it fires;
- what `checkMcpServer` printed;
- anything you didn't hook, and why. For example: "the product can't tell agent edits from human edits".
