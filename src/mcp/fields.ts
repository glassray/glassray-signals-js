import { z } from "zod";
import { MAX_MESSAGE_CHARS, type SignalInput } from "../types.ts";

/*
 * A person's reaction, said in the agent's own chat. The product never sees that chat, so the agent
 * passes the words on: with the pass_on_user_reaction tool, or with these fields on any of the
 * product's own tools (wrapMcpServer notices them in any call).
 */

export const USER_REACTIONS = ["unhappy", "asked_for_change", "happy"] as const;
export type UserReaction = (typeof USER_REACTIONS)[number];

const SIGNAL_FOR: Record<UserReaction, { kind: string; sentiment: "negative" | "neutral" | "positive" }> = {
  unhappy: { kind: "correction", sentiment: "negative" },
  asked_for_change: { kind: "change_request", sentiment: "neutral" },
  happy: { kind: "praise", sentiment: "positive" },
};

export const USER_SAID_DESCRIPTION =
  'The words of the person you work for, copied exactly from your chat ("this is not good", "that should never happen", "add filters"). Leave it out when they said nothing about this.';
export const USER_REACTION_DESCRIPTION =
  "How they felt about your work when they said it: unhappy (something was wrong or not good, even if you disagree), asked_for_change (a request, no complaint), happy.";

/**
 * Built with your own zod (a peer dependency), so it mixes into schemas made with zod 3 or 4.
 * Spread into the input schema of your own tools where a person's reaction belongs
 * (save a decision, report a problem): `inputSchema: { ...yourFields, ...userReactionFields }`.
 */
export const userReactionFields = {
  user_said: z.string().max(MAX_MESSAGE_CHARS).optional().describe(USER_SAID_DESCRIPTION),
  user_reaction: z.enum(USER_REACTIONS).optional().describe(`${USER_REACTION_DESCRIPTION} Default asked_for_change.`),
};

/** The signal for a person's words that an agent passed on: from the user, relayed by the agent. */
export function reactionSignal(input: { said: string; reaction?: UserReaction; via: string; note?: string }): SignalInput | null {
  const said = input.said.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!said) return null;
  const { kind, sentiment } = SIGNAL_FOR[input.reaction ?? "asked_for_change"];
  return {
    source: "user",
    kind,
    sentiment,
    message: said,
    relayed_by: "agent",
    context: { via: input.via, ...(input.note ? { agent_note: input.note.slice(0, 1000) } : {}) },
  };
}

export function isUserReaction(v: unknown): v is UserReaction {
  return typeof v === "string" && (USER_REACTIONS as readonly string[]).includes(v);
}
