/**
 * Load `.env` for the gate scripts, if there is one.
 *
 * Nothing in this repo reads `.env` on its own, and `package.json` declares
 * `node >=20`, which includes versions without `--env-file-if-exists`. So this
 * uses `process.loadEnvFile` where it exists and does nothing where it does not
 * — a missing file or an old Node is never an error, because the clients throw
 * a named `Missing*KeyError` at construction when the key really is absent.
 *
 * Variables already in the environment win over the file, so an exported
 * credential is never silently replaced by a stale `.env` entry. The file is
 * gitignored; it is read here and never echoed.
 */
export function loadDotEnv(file = ".env"): void {
  if (typeof process.loadEnvFile !== "function") return;
  try {
    process.loadEnvFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
