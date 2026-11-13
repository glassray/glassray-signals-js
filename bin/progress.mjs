/*
 * What the setup command tells Glassray while a coding agent is wiring it into the repo.
 *
 * That work can take a quarter of an hour on a real codebase, and the setup page would otherwise hear
 * nothing between the test signal and the product's first real one, so a run that is working looks
 * like one that crashed. The command is the agent's parent process, so it can see what the agent
 * cannot be relied on to say: which facts are now true in the repo, and that the agent is still alive.
 *
 * It sends file paths inside the repo and five yes/no facts. Never a file's contents. It prints
 * nothing, because the agent owns the terminal while this runs, and it never throws.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SDK = "@glassray/signals";
const CODE = /\.(m?[jt]sx?|c[jt]s|vue|svelte)$/;
const TEST = /(^|\/)(tests?|__tests__|e2e|spec)\/|\.(test|spec)\.[a-z]+$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", ".claude", ".cursor", ".agents"]);
/* files the agent's work touches that say nothing about where it has got to */
const NOT_WORK = /(^|\/)(\.env[^/]*|[^/]*\.lock|[^/]*-lock\.(json|yaml)|bun\.lockb)$|(^|\/)\.(claude|cursor|agents)\//;

function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "ignore"] });
  /* git grep exits 1 for "no matches", which is an answer; anything else means this is not a repo we can ask */
  return r.status === 0 || r.status === 1 ? r.stdout.split("\n").filter(Boolean) : null;
}

/** A bounded walk, for a folder that is not a git repo. */
function walk(cwd, wanted, limit = 4000) {
  const out = [];
  const queue = [""];
  let seen = 0;
  while (queue.length && seen < limit) {
    const dir = queue.shift();
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(cwd, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) queue.push(rel);
      } else if (++seen <= limit && wanted(rel)) out.push(rel);
    }
  }
  return out;
}

const read = (cwd, rel) => {
  try {
    const abs = path.join(cwd, rel);
    return fs.statSync(abs).size > 512 * 1024 ? null : fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

/**
 * What is true in the repo right now, each fact with the file that makes it true:
 *   sdk      package.json depends on the SDK
 *   init     init() is called, outside the tests
 *   mcp      an MCP server is wrapped
 *   signals  signal() is called somewhere a person or the app does something, outside the tests
 *   check    a test runs checkMcpServer
 * and the file changed most recently, which is what the agent is working on.
 */
export function repoFacts(cwd) {
  const found = { sdk: undefined, init: undefined, mcp: undefined, signals: undefined, check: undefined };
  const relevant = (rel) => path.basename(rel) === "package.json" || CODE.test(rel);
  const files = (git(cwd, ["grep", "-l", "--untracked", "-F", SDK]) ?? walk(cwd, relevant)).filter((rel) => relevant(rel) && !NOT_WORK.test(rel));

  for (const rel of files.slice(0, 400)) {
    const text = read(cwd, rel);
    if (!text || !text.includes(SDK)) continue;
    if (path.basename(rel) === "package.json") {
      try {
        const pkg = JSON.parse(text);
        if ([pkg.dependencies, pkg.devDependencies, pkg.optionalDependencies].some((d) => d && SDK in d)) found.sdk ??= rel;
      } catch {
        /* a package.json mid-edit: ask again in a few seconds */
      }
      continue;
    }
    const test = TEST.test(rel);
    if (/\bwrapMcpServer\s*\(/.test(text)) found.mcp ??= rel;
    if (/\bcheckMcpServer\s*\(/.test(text)) found.check ??= rel;
    if (!test && /\binit\s*\(/.test(text)) found.init ??= rel;
    if (!test && /\bsignal\s*\(\s*\{/.test(text)) found.signals ??= rel;
  }

  let lastFile;
  let newest = 0;
  for (const rel of git(cwd, ["ls-files", "-m", "-o", "--exclude-standard"]) ?? []) {
    if (NOT_WORK.test(rel)) continue;
    try {
      const at = fs.statSync(path.join(cwd, rel)).mtimeMs;
      if (at > newest) [newest, lastFile] = [at, rel];
    } catch {
      /* deleted since git listed it */
    }
  }

  return {
    steps: ["sdk", "init", "mcp", "signals", "check"].map((id) => ({ id, done: Boolean(found[id]), ...(found[id] ? { file: found[id] } : {}) })),
    ...(lastFile ? { lastFile } : {}),
  };
}

/**
 * Reports every few seconds until stop() is called with how the agent ended. Posting at all is the
 * heartbeat: when the posts stop without a final one, the terminal went away.
 */
export function startProgress({ cwd, endpoint, apiKey, agent, prompt, everyMs = 5000, fetch: fetchFn = globalThis.fetch }) {
  const run = crypto.randomUUID();
  const send = async (state, exitCode) => {
    try {
      const facts = repoFacts(cwd);
      await fetchFn(`${endpoint}/v1/setup/progress`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ run, agent, state, exit_code: exitCode ?? null, steps: facts.steps, ...(facts.lastFile ? { last_file: facts.lastFile } : {}), prompt: prompt.slice(0, 2000) }),
        signal: AbortSignal.timeout(4000),
      });
    } catch {
      /* Glassray unreachable, or the repo unreadable for a moment: the next one may get through */
    }
  };
  void send("running");
  const timer = setInterval(() => void send("running"), everyMs);
  timer.unref?.();
  return {
    stop: async (exitCode) => {
      clearInterval(timer);
      await send("exited", exitCode);
    },
  };
}
