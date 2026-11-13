/*
 * Does the built package load and send on this version of Node? Runs on every version
 * engines.node allows, against dist rather than src, because dist is what an installer gets.
 */
import assert from "node:assert/strict";
import { init, signal, withContext, flush } from "../dist/index.js";

const sent = [];
init({
  apiKey: "gr_smoke",
  endpoint: "https://glassray.invalid",
  onError: () => {},
  fetch: async (_url, req) => {
    sent.push(...JSON.parse(String(req?.body)).signals);
    return new Response("{}", { status: 202 });
  },
});

await withContext({ user: "maya", workItem: { type: "canvas", id: "c_1" } }, async () => {
  signal({ source: "agent", kind: "tool_failure", message: "smoke" });
});
await flush();

assert.equal(sent.length, 1, "one signal was sent");
assert.equal(sent[0].kind, "tool_failure");
assert.deepEqual(sent[0].work_item, { type: "canvas", id: "c_1" }, "the context was filled in");
assert.equal(sent[0].refs?.user, "maya");
console.log(`ok on node ${process.versions.node}: context filled in, 1 signal sent`);
