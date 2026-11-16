/**
 * Fork build identity (see FORK.md at the repo root).
 *
 * `scripts/fork/build.mjs` sets NIMBALYST_FORK_BUILD=true, NIMBALYST_FORK_COMMIT=<sha>
 * and NIMBALYST_FORK_REPO=<owner>/<repo> at build time; electron.vite.config.ts
 * injects them into the main and renderer bundles with `define`, the same way
 * OFFICIAL_BUILD is injected. Upstream builds compile them to their "off"
 * values, so nothing here changes behavior outside the fork.
 *
 * These are functions, not constants, so unit tests can toggle the
 * environment between cases. In a bundle `define` replaces each
 * `process.env.*` read with a literal.
 */
export function isForkBuild(): boolean {
  return process.env.NIMBALYST_FORK_BUILD === 'true';
}

export function getForkCommit(): string {
  return process.env.NIMBALYST_FORK_COMMIT || 'unknown';
}

/** "owner/repo" of the fork on GitHub, or '' when unknown. */
export function getForkRepo(): string {
  return process.env.NIMBALYST_FORK_REPO || '';
}

export const FORK_UPDATE_INSTRUCTIONS =
  'This fork build does not update itself. In the fork checkout, run `node scripts/fork/update.mjs` ' +
  '(merges the newest upstream release into fork/main, builds and smoke-tests), then quit Nimbalyst and run ' +
  '`node scripts/fork/install.mjs`. See FORK.md.';
