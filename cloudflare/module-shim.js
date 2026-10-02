// @ts-check

/**
 * @file Stand-in for Node's `module` built-in on Workers (wrangler.jsonc `alias`).
 *
 * `src/cards/gist.js` and `src/cards/wakatime.js` load
 * `src/common/languageColors.json` through `createRequire(import.meta.url)`.
 * Workers have no file system and no `import.meta.url` for bundled modules,
 * so this shim returns a `require` that serves the bundled JSON instead.
 */

import languageColors from "../src/common/languageColors.json";

/**
 * Returns a `require` function that knows only the bundled JSON modules.
 *
 * @returns {(id: string) => any} Require function.
 */
export const createRequire = () => (id) => {
  if (id.endsWith("/languageColors.json")) {
    return languageColors;
  }
  throw new Error(`Module not bundled for Workers: ${id}`);
};

export default { createRequire };
