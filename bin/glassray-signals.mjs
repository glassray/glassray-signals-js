#!/usr/bin/env node
/*
 * npx @glassray/signals setup [--to <dir>]
 * Copies the glassray-setup skill into the repo, so a coding agent (Claude Code, Cursor, Codex…) can set
 * Glassray up with the version of the instructions that matches this SDK. Then prints the prompt to give it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.join(here, "..", "skills", "glassray-setup");
const [cmd, ...rest] = process.argv.slice(2);

if (cmd !== "setup") {
  console.log("Usage: npx @glassray/signals setup [--to <dir>]\n\nCopies the glassray-setup skill into this repo (default .claude/skills/glassray-setup).");
  process.exit(cmd ? 1 : 0);
}

const toFlag = rest.indexOf("--to");
const target = path.resolve(toFlag >= 0 && rest[toFlag + 1] ? rest[toFlag + 1] : path.join(".claude", "skills", "glassray-setup"));
fs.mkdirSync(target, { recursive: true });
for (const file of fs.readdirSync(skill)) fs.copyFileSync(path.join(skill, file), path.join(target, file));

console.log(`Copied the glassray-setup skill to ${path.relative(process.cwd(), target) || "."}

Now ask your coding agent:

  Set up Glassray in this repo using the glassray-setup skill.

Other agents: point them at ${path.relative(process.cwd(), path.join(target, "SKILL.md"))}.`);
