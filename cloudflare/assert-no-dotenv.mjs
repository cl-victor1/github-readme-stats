/**
 * Deploy gate for `npm run cf:deploy`: exits 1 when the repository root holds
 * a `.env*` or `.dev.vars` file, so a deploy runs only from a clean copy and
 * local secrets cannot end up in the upload. It prints file names, never values.
 */
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const found = readdirSync(root).filter(
  (name) => name.startsWith(".env") || name.startsWith(".dev.vars"),
);

if (found.length > 0) {
  console.error(
    `[assert-no-dotenv] Found ${found.join(", ")} in ${root}. ` +
      "Deploy from a copy of the repository without these files (see cloudflare/AGENTS.md).",
  );
  process.exit(1);
}
