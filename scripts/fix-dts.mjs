/* tsc keeps ".ts" in relative imports inside .d.ts files even with rewriteRelativeImportExtensions.
   Consumers without allowImportingTsExtensions would fail on them, so point them at ".js" like the JS. */
import fs from "node:fs";
import path from "node:path";
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
for (const f of walk("dist").filter((f) => f.endsWith(".d.ts"))) {
  const src = fs.readFileSync(f, "utf8");
  const out = src.replace(/(from\s+["']|import\(["'])(\.{1,2}\/[^"']+)\.ts(["'])/g, "$1$2.js$3");
  if (out !== src) fs.writeFileSync(f, out);
}
