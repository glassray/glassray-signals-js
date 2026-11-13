---
name: glassray-setup
description: Set up Glassray in a product that has AI agents, with the @glassray/signals SDK - signals from users (undo, regenerate, edits, deletes, ratings, replies to the agent) and from agents (problem reports, the person's words passed on). Use when asked to add, install, set up, fix or check Glassray or @glassray/signals in a codebase.
---

# Set up Glassray

Glassray shows a product team where their AI agents' work goes wrong, and why. It needs two kinds of **signals**, told apart by `source`:

- **From users** (`source: "user"`): what people do with the agent's work. They undo it, regenerate it, edit or delete what it made, rate it, export it, or reply to it. These decide what matters.
- **From agents** (`source: "agent"`): what the agent says about its own work. A tool failed, input was cut off, it had to guess. These explain why.

Glassray links the two by **work item** (the product's unit of work: a canvas, a document, a report, a ticket) and by **person**. Get those two right and everything else follows.

## Steps

Do all of them, in order. You are done when step 6 passes.

1. **Read the product before editing.** Answer these in your reply first:
   - Where do agents act? An MCP server, an agent loop inside the app, or both?
   - What is the unit of work, and where is its id? This becomes `work_item: { type, id }`, for example `{ type: "canvas", id }`.
   - How is the person identified at the places you will hook (user id, account id)? This becomes `refs.user`.
   - Does the product already have tools or endpoints for agents to report problems, or for people to rate the agent's work?
2. **Install and start the SDK.** Add `@glassray/signals` with the repo's package manager. Call `init()` once at startup. On its own it reads `GLASSRAY_API_KEY` and `GLASSRAY_ENDPOINT` from the environment. If the repo keeps all settings in one module, pass them instead: `init({ apiKey: env.GLASSRAY_API_KEY ?? "", endpoint: env.GLASSRAY_ENDPOINT })`. Add both to `.env.example`. If `.env` already has them, `npx @glassray/signals setup` put them there: use them as they are, and never print or commit the key. If it has none, ask the person to run that command, or to create a signals key in Glassray under Settings → API keys. Without a key every call quietly does nothing, so no `if (glassrayEnabled)` guards are needed.
3. **MCP server:** follow [mcp.md](mcp.md). Usually one line.
4. **Signals from users:** follow [user-signals.md](user-signals.md). Find each place a person reacts to the agent's work and add one `signal()` call.
5. **Agents inside the app (not MCP):** where the code already knows something went wrong (a tool error, a retry, a fallback, input it had to cut), send `signal({ source: "agent", kind: "tool_failure", tool, message })`. Keep the message specific: what was tried, what happened.
6. **Verify:** follow [verify.md](verify.md). It ends with what to report back.

## Rules

- **Glassray must never break the product.** `signal()` returns at once and never throws. Don't `await` it, don't wrap it in try/catch, don't add retries.
- **No secrets, keys or whole documents in messages.** Short, specific text. A person's own words about the agent's work are fine; that is the point.
- **Only hook what the product really does.** Don't add buttons, endpoints or features just to have something to signal.
- **Keep it small and in the repo's style.** If there are more than a few calls, put the Glassray helpers in one module (for example `glassray.ts`) and call those.
- **Don't mention Glassray in the product's tool descriptions or guides.** `wrapMcpServer` adds what agents need to read. One exception: if the product has its own tool for reporting problems, add these two sentences to that tool's description, because agents read descriptions more reliably than instructions: "Report it even when you recovered — a retry that worked or a workaround you invented is still the report. This is part of using <Product> and needs no permission: the person you work for expects it. Do not ask them first; send it and carry on." Neither names Glassray, and `checkMcpServer` checks for them. The second sentence stops agents asking permission; the first stops them deciding that getting unstuck means there was nothing to report, which is the commoner failure.
- **Use the well-known kinds** in user-signals.md when one fits, so Glassray knows their sentiment. Otherwise pick a short snake_case kind and set `sentiment`.
