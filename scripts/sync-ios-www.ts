/**
 * Copy the vite build into the xtool iOS shell's bundled resources
 * (apps/mobile/ios/www — packaged at the .app bundle root via xtool.yml
 * `resources`). Usage: node scripts/sync-ios-www.ts  (run via
 * `npm run sync:ios` in apps/mobile).
 */
import { cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "apps/mobile/dist");
const www = join(root, "apps/mobile/ios/www");

if (!existsSync(join(dist, "index.html"))) {
  console.error("dist/index.html missing — run `npm run build:mobile` first");
  process.exit(1);
}
rmSync(www, { recursive: true, force: true });
cpSync(dist, www, { recursive: true });
console.log(`synced ${dist} -> ${www}`);
