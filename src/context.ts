import type { AgentRef, WorkItem } from "./types.ts";

/** What a signal is about, filled in automatically for signals sent inside withContext (or a wrapped MCP tool call). */
export type SignalContext = {
  user?: string;
  workItem?: WorkItem;
  session?: string;
  /** The trace this work belongs to, if you trace. Signals carry it so Glassray links them to the exact spans. */
  trace?: string;
  run?: string;
  agent?: AgentRef;
  /** Extra fields merged into each signal's context. */
  extra?: Record<string, unknown>;
};

type Store<T> = { getStore(): T | undefined; run<R>(store: T, fn: () => R): R };

/*
 * Per-request context. On Node (and runtimes with node:async_hooks) this is AsyncLocalStorage,
 * so it follows async work. Elsewhere it falls back to a synchronous stack: correct for
 * synchronous code, best effort across awaits.
 */
function createStore(): Store<SignalContext> {
  try {
    const getBuiltin = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule;
    const hooks = getBuiltin?.("node:async_hooks") as { AsyncLocalStorage?: new () => Store<SignalContext> } | undefined;
    if (hooks?.AsyncLocalStorage) return new hooks.AsyncLocalStorage();
  } catch {
    /* fall through */
  }
  const stack: SignalContext[] = [];
  return {
    getStore: () => stack[stack.length - 1],
    run: (store, fn) => {
      stack.push(store);
      try {
        return fn();
      } finally {
        stack.pop();
      }
    },
  };
}

const store = createStore();
let base: SignalContext = {};

export function mergeContext(a: SignalContext, b: SignalContext): SignalContext {
  return {
    ...a,
    ...b,
    ...(a.agent || b.agent ? { agent: { ...a.agent, ...b.agent } } : {}),
    ...(a.extra || b.extra ? { extra: { ...a.extra, ...b.extra } } : {}),
  };
}

/** The context in effect right now: the process-wide base, overlaid with the innermost withContext. */
export function getContext(): SignalContext {
  const current = store.getStore();
  return current ? mergeContext(base, current) : base;
}

/** Runs fn with this context added on top of the current one. Signals sent inside pick it up. */
export function withContext<R>(ctx: SignalContext, fn: () => R): R {
  return store.run(mergeContext(store.getStore() ?? {}, ctx), fn);
}

/** Sets context for the whole process (e.g. the agent's name and version). Prefer withContext for per-request values. */
export function setContext(ctx: SignalContext): void {
  base = mergeContext(base, ctx);
}

/** For tests. */
export function resetContext(): void {
  base = {};
}
