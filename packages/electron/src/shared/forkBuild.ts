/**
 * Fork build identity (see FORK.md at the repo root).
 *
 * `scripts/fork/build-win.ps1` sets NIMBALYST_FORK_BUILD=true and
 * NIMBALYST_FORK_COMMIT=<sha> at build time; electron.vite.config.ts injects
 * them into the main and renderer bundles with `define`, the same way
 * OFFICIAL_BUILD is injected. Upstream builds compile both to their "off"
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

export const FORK_UPDATE_INSTRUCTIONS =
  'This fork build does not update itself. To update, merge the next upstream release tag into fork/main, ' +
  'then run scripts/fork/build-win.ps1 and scripts/fork/install.ps1 from the fork checkout. See FORK.md.';
