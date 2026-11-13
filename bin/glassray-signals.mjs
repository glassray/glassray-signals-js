#!/usr/bin/env node
/*
 * npx @glassray/signals setup [--to <dir>] [--endpoint <url>] [--env-file <path>] [--no-login] [--login]
 *
 * 1. Copies the glassray-setup skill into the repo, so a coding agent (Claude Code, Cursor, Codex…) can set
 *    Glassray up with the version of the instructions that matches this SDK.
 * 2. Signs in through the browser and writes a signals key to .env, so nobody copies a key by hand.
 *    You check the code in the browser matches the one printed here, then pick an organization.
 * 3. Sends one signal to prove the key works.
 * 4. Hands over to your coding agent (Claude Code, Codex or Cursor, whichever is installed) in this same
 *    terminal, to wire Glassray into the code and keep going until the skill's checks pass.
 * No dependencies: Node 18+ has fetch.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startProgress } from "./progress.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.join(here, "..", "skills", "glassray-setup");
const [cmd, ...rest] = process.argv.slice(2);
const DEFAULT_ENDPOINT = "https://app.glassray.ai";

const USAGE = `Usage: npx @glassray/signals setup [options]

Sets Glassray up in this repo, from start to finish: copies the glassray-setup
skill, signs you in through the browser, writes a signals key to .env, sends a
test signal, then hands over to your coding agent to wire it into your code.

Options:
  --to <dir>          Where to copy the skill (default .claude/skills/glassray-setup)
  --endpoint <url>    Your Glassray server (default GLASSRAY_ENDPOINT, then ${DEFAULT_ENDPOINT})
  --env-file <path>   Where to write the key (default .env)
  --agent <name>      claude, codex, cursor or none (default: the first one installed)
  --no-login          Skip signing in
  --login             Get a new key even if the env file has one`;

if (cmd !== "setup") {
  console.log(USAGE);
  process.exit(cmd && cmd !== "--help" && cmd !== "-h" ? 1 : 0);
}

const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[i + 1] : undefined;
};
const has = (name) => rest.includes(name);

/* ---------------------------------------------------------------- 1. the skill */

const target = path.resolve(flag("--to") ?? path.join(".claude", "skills", "glassray-setup"));
fs.mkdirSync(target, { recursive: true });
for (const file of fs.readdirSync(skill)) fs.copyFileSync(path.join(skill, file), path.join(target, file));
console.log(`✓ Copied the glassray-setup skill to ${path.relative(process.cwd(), target) || "."}`);

/* ---------------------------------------------------------------- 2. the key */

const envFile = path.resolve(flag("--env-file") ?? ".env");
const envText = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
const fromEnvFile = (name) => envText.match(new RegExp(`^${name}=["']?([^"'\\n]*)`, "m"))?.[1];
const endpoint = (flag("--endpoint") ?? process.env.GLASSRAY_ENDPOINT ?? fromEnvFile("GLASSRAY_ENDPOINT") ?? DEFAULT_ENDPOINT).replace(/\/+$/, "");
const existingKey = fromEnvFile("GLASSRAY_API_KEY");
const envName = path.relative(process.cwd(), envFile) || envFile;
/* The key in hand and the server it is for: from .env when it is already there, from sign-in otherwise. */
let session = { apiKey: existingKey, endpoint };

async function login() {
  /* shown in the browser next to the code, so the person can tell this terminal's request from someone else's */
  const start = await post("/v1/cli/logins", { device: `${os.hostname()}, folder ${path.basename(process.cwd())}` });
  console.log(`
Sign in to Glassray to get a key for this repo.

  Your code:  ${start.user_code}
  Open:       ${start.url}

Check the code in your browser matches, then allow it.`);
  openBrowser(start.url);
  process.stdout.write("\nWaiting for you to allow it…");

  /* allowing it just before the code expires still gives a few minutes to collect the key */
  const until = (Date.parse(start.expires_at) || Date.now() + 10 * 60_000) + 5 * 60_000;
  const every = Math.max(1, Number(start.interval) || 2) * 1000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, every));
    const res = await fetch(`${endpoint}/v1/cli/logins/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: start.token }),
    }).catch(() => null);
    if (!res) continue; /* a blip on the network: ask again */
    const body = await res.json().catch(() => ({}));
    if (body.status === "pending") continue;
    if (body.status !== "approved") throw new Error(body.error ?? `Sign-in failed (${res.status}).`);
    console.log(" allowed.");
    session = { apiKey: body.api_key, endpoint: (body.endpoint ?? endpoint).replace(/\/+$/, "") };
    writeEnv({ GLASSRAY_API_KEY: body.api_key, GLASSRAY_ENDPOINT: body.endpoint ?? endpoint });
    console.log(`✓ Wrote GLASSRAY_API_KEY and GLASSRAY_ENDPOINT to ${envName}${body.org?.name ? ` (organization: ${body.org.name})` : ""}`);
    warnIfTracked();
    await testSignal(body.api_key, body.endpoint ?? endpoint);
    await done();
    return;
  }
  throw new Error("The sign-in expired after 10 minutes. Run setup again.");
}

async function post(p, body) {
  let res;
  try {
    res = await fetch(`${endpoint}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(`Could not reach Glassray at ${endpoint}. Pass --endpoint with your server's address.`);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Glassray answered ${res.status} at ${endpoint}${p}.`);
  return json;
}

/** Replace the two lines if they are there, add them if not. Everything else in the file stays. */
function writeEnv(vars) {
  let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  for (const [k, v] of Object.entries(vars)) {
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, "m");
    if (re.test(text)) text = text.replace(re, line);
    else text += `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`;
  }
  fs.writeFileSync(envFile, text);
}

/** A key in a committed file is a key anyone with the repo can use. Say so; don't touch .gitignore. */
function warnIfTracked() {
  const r = spawnSync("git", ["check-ignore", "-q", envFile], { stdio: "ignore" });
  if (r.status === 1) console.log(`! ${envName} is not ignored by git. Add it to .gitignore so the key is not committed.`);
}

/** One signal from an agent, so Glassray shows the repo as connected the moment setup ends. */
async function testSignal(apiKey, base) {
  const res = await fetch(`${base}/v1/signals`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      source: "agent",
      kind: "success",
      message: "Glassray setup connected this repo.",
      work_item: "setup:test",
      agent: { name: "glassray-setup" },
      /* marks it as setup's test, so Glassray doesn't count it as the product's data */
      context: { glassray_setup_test: true },
    }),
  }).catch(() => null);
  if (res?.ok) console.log("✓ Sent a test signal. Glassray shows it now.");
  else console.log(`! The key was written, but a test signal did not arrive (${res ? res.status : "no answer"}).`);
}

function openBrowser(url) {
  if (process.env.CI || process.env.SSH_CONNECTION) return;
  const [bin, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(bin, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    /* no browser here: the link is printed above */
  }
}

/* The coding agents we can hand over to, in the order we try them, with how each takes a first prompt. */
const AGENTS = [
  { name: "claude", label: "Claude Code", bin: "claude", args: (p) => [p] },
  { name: "codex", label: "Codex", bin: "codex", args: (p) => [p] },
  { name: "cursor", label: "Cursor", bin: "cursor-agent", args: (p) => [p] },
];

function installed(bin) {
  return spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" }).status === 0;
}

/**
 * The rest is code: hand over to the person's coding agent here, in this terminal, so one command goes
 * from nothing to a product that sends signals. When nobody is at the terminal (CI, or an agent ran this
 * command itself) we print the prompt instead; an agent reading it carries on from there.
 */
async function done() {
  const skillPath = path.relative(process.cwd(), path.join(target, "SKILL.md"));
  const prompt = `Set up Glassray in this repo using the glassray-setup skill (${skillPath}). GLASSRAY_API_KEY and GLASSRAY_ENDPOINT are already in ${envName}. Keep going until every step of the skill passes, including one real signal from the app.`;
  const wanted = flag("--agent");
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !process.env.CI;
  const agent = wanted === "none" || !interactive ? null : AGENTS.find((a) => (wanted ? a.name === wanted : true) && installed(a.bin));

  if (!agent) {
    if (wanted && wanted !== "none" && interactive) console.log(`\n! ${wanted} is not installed.`);
    console.log(`\nNow give your coding agent this prompt:\n\n  ${prompt}`);
    return;
  }
  console.log(`\n→ Handing over to ${agent.label} to wire Glassray into your code. It keeps going until the checks pass.\n`);

  /* While the agent works, tell Glassray what is true in the repo and that the agent is still alive,
     so the setup page fills in instead of sitting still. Nothing is printed: the terminal is the agent's. */
  const reporter = session.apiKey?.startsWith("gr_") ? startProgress({ cwd: process.cwd(), endpoint: session.endpoint, apiKey: session.apiKey, agent: agent.label, prompt }) : null;
  /* Ctrl-C belongs to the agent. We stay, so we can say that it ended. */
  const hold = () => {};
  process.on("SIGINT", hold);
  const ended = await new Promise((resolve) => {
    const child = spawn(agent.bin, agent.args(prompt), { stdio: "inherit" });
    child.on("error", () => resolve({ failed: true }));
    child.on("exit", (code) => resolve({ code }));
  });
  process.off("SIGINT", hold);
  await reporter?.stop(ended.failed ? null : ended.code);
  if (ended.failed) console.log(`\n! Could not start ${agent.label}. Give your coding agent this prompt:\n\n  ${prompt}`);
}

/*
 * Run it. This stays at the bottom of the file: the functions above are hoisted, but the constants
 * they read (AGENTS) are not, and starting from the top meant a person at a real terminal hit
 * "Cannot access 'AGENTS' before initialization" at the hand-over, after sign-in had already worked.
 */
if (has("--no-login")) {
  await done();
} else if (existingKey?.startsWith("gr_") && !has("--login")) {
  console.log(`✓ ${envName} already has GLASSRAY_API_KEY. Run with --login to get a new one.`);
  await done();
} else {
  await login().catch((err) => {
    console.error(`\n✗ ${err.message}`);
    console.error(`  You can still create a signals key in Glassray under Settings → API keys and put it in ${envName} as GLASSRAY_API_KEY.`);
    process.exitCode = 1;
  });
}
