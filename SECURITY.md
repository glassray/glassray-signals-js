# Security

## Supported versions

Only the latest published version of `@glassray/signals` gets fixes. Upgrade before reporting,
because the problem may already be gone.

## Reporting

Please do not open a public issue for anything that exposes data. Report it through
[GitHub private vulnerability reporting](https://github.com/glassray/glassray-signals-js/security/advisories/new),
which is "Report a vulnerability" on this repository's Security tab. Include the commit you are on,
how to reproduce it, and the impact you believe it has. You will get an acknowledgement within a few
working days.

## What this package sends, and where

Only the signals your code passes to `signal()`, the context you set, and, for MCP servers, one
breadcrumb per tool call holding the tool name, whether it succeeded, the error text and the
duration. It reads no files, and nothing from the machine beyond `GLASSRAY_API_KEY` and
`GLASSRAY_ENDPOINT`.

The setup command, `npx @glassray/signals setup`, sends one more thing while a coding agent is
wiring Glassray into the repo: every few seconds, five yes or no facts (is the SDK a dependency, is
`init()` called, is an MCP server wrapped, is `signal()` called, is there a `checkMcpServer` test), the
path of the file each one was found in, and the path of the file changed most recently. Paths inside
the repo only, never a file's contents, and never `.env` or a lockfile. It stops when the agent does.

Signals go over HTTPS to `GLASSRAY_ENDPOINT`, which defaults to `https://app.glassray.ai`, and
nowhere else. A signals key can only send: code holding it cannot read any signal, issue or
investigation back out.

## Notes for reviewers

There are no runtime dependencies, so installing this pulls in no third-party code at run time.
`@modelcontextprotocol/sdk` and `zod` are optional peers, used only by `/mcp` and `/testing`.

Installing from npm runs no install scripts: the published package carries its built `dist`. The
one script, `prepare`, runs `npm run build` only when the package is installed from git, where `dist`
is not in the repository. Install with `--ignore-scripts` to skip it and build yourself.

A signal's `message` holds whatever an agent or a person wrote, so it can carry anything they typed.
The tool descriptions tell agents never to include secrets, which is an instruction to a model
rather than a guarantee. `beforeSend` runs after the context is filled in and before anything is
queued: return `null` to drop a signal, or edit it to remove a field. A rule you need to hold
belongs there.
