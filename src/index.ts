import { SignalsClient, type SignalsOptions } from "./client.ts";
import type { SignalInput } from "./types.ts";

/*
 * The module API: init once, then signal() from anywhere. Before init (or without a
 * key) every call is a no-op, so the calls can stay in the code everywhere.
 */
let client: SignalsClient | null = null;

/** Sets up sending. Reads GLASSRAY_API_KEY and GLASSRAY_ENDPOINT unless you pass apiKey / endpoint. Calling it again replaces the setup. */
export function init(opts: SignalsOptions = {}): SignalsClient {
  client = new SignalsClient(opts);
  return client;
}

/** The client init created, or null before init. */
export function getClient(): SignalsClient | null {
  return client;
}

/** @internal For checkMcpServer: swaps the default client and returns the previous one. */
export function _swapClient(next: SignalsClient | null): SignalsClient | null {
  const prev = client;
  client = next;
  return prev;
}

/** Sends one signal. See SignalsClient.signal. */
export function signal(s: SignalInput): void {
  client?.signal(s);
}

/** Sends everything queued and waits. */
export async function flush(): Promise<void> {
  await client?.flush();
}

export { SignalsClient, applyContext, type Enricher, type SignalsOptions } from "./client.ts";
export { getContext, setContext, withContext, resetContext, type SignalContext } from "./context.ts";
export {
  AGENT_KINDS,
  MAX_MESSAGE_CHARS,
  type AgentKind,
  type AgentRef,
  type AgentSourceSignal,
  type Refs,
  type SignalInput,
  type Source,
  type UserSourceSignal,
  type WorkItem,
} from "./types.ts";
