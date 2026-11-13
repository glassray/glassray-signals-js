/*
 * The signal shape, as plain TypeScript types with no runtime dependency.
 * It mirrors @glassray/schema (the server's validator); a contract test in the
 * Glassray repo fails the build if the two ever disagree.
 */

export const MAX_MESSAGE_CHARS = 4000;

/** Who a signal comes from: a person reacting to an agent's work, or the agent itself. */
export type Source = "user" | "agent";

/** Well-known kinds for an agent's work. Any source may use any kind; these are suggestions. */
export const AGENT_KINDS = [
  "input_problem",
  "instruction_conflict",
  "uncertain_decision",
  "tool_failure",
  "missing_capability",
  "confusing",
  "idea",
  "success",
  "other",
] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Your own unit of work: a canvas, a report, a ticket. A string, or a typed id. */
export type WorkItem = string | { type: string; id: string };

export type Refs = { run?: string; session?: string; trace?: string; message?: string; user?: string };

export type AgentRef = { name?: string; version?: string; client?: string };

type Common = {
  /** Idempotency key: the same id is stored once. */
  id?: string;
  /** ISO time or epoch milliseconds. Defaults to when the signal was queued. */
  at?: string | number;
  work_item?: WorkItem;
  refs?: Refs;
  agent?: AgentRef;
  context?: Record<string, unknown>;
  sentiment?: "negative" | "neutral" | "positive";
  value?: number;
  /** The tool involved, when there is one. */
  tool?: string;
  severity?: "low" | "medium" | "high";
  /** What the agent chose when it was unsure, and why. */
  decision?: string;
  evidence?: string;
  /** "agent": a person said this in an agent's chat and the agent passed it on, word for word. */
  relayed_by?: "agent";
};

/** Something a person did or said about an agent's work: undo, regenerate, edit, rating, reply, export. */
export type UserSourceSignal = Common & { source: "user"; kind: string; message?: string };

/** Something an agent said about its own work. It always says what happened. Any kind; AGENT_KINDS are the well-known ones. */
export type AgentSourceSignal = Common & { source: "agent"; kind: AgentKind | (string & {}); message: string };

export type SignalInput = UserSourceSignal | AgentSourceSignal;
