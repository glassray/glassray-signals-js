# Security

## Supported versions

Only the latest commit on `main` gets fixes. This package is not on npm yet, so an install pins a
commit; upgrade before reporting, because the problem may already be gone.

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

Signals go over HTTPS to `GLASSRAY_ENDPOINT`, which defaults to `https://app.glassray.ai`, and
nowhere else. A signals key can only send: code holding it cannot read any signal, issue or
investigation back out.

## Notes for reviewers

There are no runtime dependencies, so installing this pulls in no third-party code at run time.
`@modelcontextprotocol/sdk` and `zod` are optional peers, used only by `/mcp` and `/testing`.

There is one install script. `prepare` runs `npm run build`, because the package is installed from
git and `exports` point at `dist`, which the repository does not carry. It runs `tsc` and a script
that rewrites import extensions in the generated `.d.ts` files, both inside the package directory.
When that matters to you, install with `--ignore-scripts` and run `npm run build` yourself.

A signal's `message` holds whatever an agent or a person wrote, so it can carry anything they typed.
The tool descriptions tell agents never to include secrets, which is an instruction to a model
rather than a guarantee. `beforeSend` runs after the context is filled in and before anything is
queued: return `null` to drop a signal, or edit it to remove a field. A rule you need to hold
belongs there.
