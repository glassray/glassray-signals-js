# Signals from users

A signal from a user is something a person **did or said about the agent's work**. These decide what Glassray investigates: a negative signal from a user starts an investigation by default.

## Where to look

Search the codebase for the places where a person acts on something an agent made:

| The person… | Look for | kind |
|---|---|---|
| undoes the agent's change | undo/history handlers, "revert" endpoints | `undo` or `revert` |
| asks for another try | regenerate/retry buttons and endpoints | `regenerate` |
| replaces or substantially edits what the agent made | update handlers on agent-made content | `replaced_agent_work` |
| deletes what the agent made | delete handlers | `deleted_agent_work` |
| writes back to the agent ("no, rounder corners") | replies to an agent task, comments addressed to the agent | `correction` (put their words in `message`) |
| marks it as needing work | status changes: needs review, rejected | `needs_review` |
| approves, ships or uses it | approve, ready for dev, publish, send, export | `approved`, `ready_for_dev`, `sent`, `export` |
| rates it | thumbs, stars, ratings | `thumbs_up`, `thumbs_down`, or a kind with `value` and `sentiment` |
| stops the agent mid-task, or gives up | stop/cancel on an agent run, closing a draft | `abandon` |
| rejects or dismisses an agent's suggestion | reject/dismiss on proposals, suggestions | `rejected` |

These kinds have known sentiments. Others need `sentiment` set.

## How to tell it was the agent's work

Only signal when the thing was made or last changed by an agent. Most products record an author or actor on the change: check it.

How recent the agent's change must be depends on the action:
- **Edits and deletes:** within about 30 minutes of the agent's change. Otherwise every later edit of an old document counts as a reaction to the agent.
- **Undo, revert and restore:** no limit. Choosing to throw away exactly what the agent did is a reaction, whenever it happens.
- **Approvals and ratings:** no limit, but only the first time for each piece of agent work, not every re-approval.

If the product cannot tell agent work from human work, say so in your report instead of guessing.

## The call

Put it where the change is saved (the server side), after it succeeded:

```ts
import { signal } from "@glassray/signals";

signal({
  source: "user",
  kind: "deleted_agent_work",
  work_item: { type: "canvas", id: canvas.id },
  refs: { user: user.id },
  message: replyText, // only when the person wrote something
  context: { frame: frame.id, agent: lastEditor.name }, // small, useful details
});
```

Inside an MCP tool call wrapped by `wrapMcpServer`, the person and work item are already filled in.

## What not to signal

- Every keystroke or autosave. Signal the meaningful action (the delete, the replace, the rating), once.
- People's own work that no agent touched.
- Anything in the agent's own chat. That is the agent's job: it passes the person's words on with `pass_on_user_reaction`.
