# Contributing

This package is developed in Glassray's monorepo, next to the server that receives the signals and
the schema it validates them against, and mirrored to this repository. The mirror is written by a
script: each sync pushes one commit whose tree is the package as it stands upstream. A pull request
merged here is overwritten by the next sync, so please do not send one.

What does work:

- **Open an issue.** A bug, a missing field, a tool that behaves unlike its description, or wording
  an agent misread. Say which version you are on and what the agent did.
- **Paste the check output.** `formatChecks(await checkMcpServer(...))` is one line per check and
  usually says enough on its own.
- **Propose wording.** The instructions paragraph and the report tool's description are the part
  that decides whether agents report at all, and we change them when a run shows they read badly.
  Describe the run.

We will say in the issue when a change has landed upstream and which sync carries it.

## Running it locally

Clone this repository, then:

```sh
npm install     # builds dist through the prepare script
npm test        # 19 tests, Node's own runner, no network
npm run typecheck
node scripts/smoke.mjs   # the built package on this version of Node
```

`npm test` needs Node 22.6 or later, because it runs the TypeScript in `src` directly. The package
itself works on Node 18 and later, which is what `scripts/smoke.mjs` checks against `dist` in CI.

The tests run the TypeScript in `src` directly through Node's type stripping and the `source`
export condition, so there is no build step between editing and testing. Only erasable syntax
works: no enums, no parameter properties, and imports end in `.ts`.

## What the package holds to

Three rules decide most arguments about this code.

It never breaks the product it is installed in. Every call returns at once and swallows its errors,
sending happens in the background, and the queue is bounded. A Glassray outage must be invisible.

It has no runtime dependencies. `@modelcontextprotocol/sdk` and `zod` are optional peers used only
by `/mcp` and `/testing`, which an MCP server already has. Before adding anything, ask whether
thirty lines would do.

The contract only grows. The types in `src/types.ts` restate the server's schema rather than
importing it, and a test upstream fails when the two disagree. Add optional fields; never rename or
remove one.
