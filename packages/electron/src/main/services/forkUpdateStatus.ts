/**
 * Pure decision logic for the fork build's "update available" notice
 * (FORK.md). No Electron imports, so it is unit-testable.
 *
 * Two things can make a fork build out of date:
 * - upstream published a stable release newer than the version this build is
 *   based on (merge it with `node scripts/fork/update.mjs`), or
 * - the fork's fork/main branch has commits this build does not contain
 *   (rebuild and reinstall).
 */

export interface ForkUpdateFacts {
  /** app.getVersion(): the upstream version the build is based on, e.g. "0.83.0". */
  upstreamVersion: string;
  /** tag_name of upstream's latest stable release, e.g. "v0.84.1"; null when unknown. */
  latestUpstreamTag: string | null;
  /** Commits on fork/main that are not in this build; null when unknown. */
  forkCommitsAhead: number | null;
  /** SHA of fork/main's head when known. */
  forkHeadSha: string | null;
}

export interface ForkUpdateStatus {
  /** The newer upstream release tag, or null. */
  upstreamRelease: string | null;
  /** Commits on fork/main not in this build (0 when none or unknown). */
  forkCommitsAhead: number;
  /** True when any check could not be completed. */
  incomplete: boolean;
  /** Identifies this "out of date" state, so the notice is shown once per state. Null when up to date. */
  key: string | null;
  /** Human-readable lines for a notification or dialog. */
  lines: string[];
}

function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when `candidate` is a strictly newer plain x.y.z version than `current`. Prereleases never qualify. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export function planForkUpdateStatus(facts: ForkUpdateFacts): ForkUpdateStatus {
  const upstreamRelease =
    facts.latestUpstreamTag && isNewerVersion(facts.latestUpstreamTag, facts.upstreamVersion)
      ? facts.latestUpstreamTag
      : null;
  const forkCommitsAhead = facts.forkCommitsAhead && facts.forkCommitsAhead > 0 ? facts.forkCommitsAhead : 0;
  const incomplete = facts.latestUpstreamTag === null || facts.forkCommitsAhead === null;

  const lines: string[] = [];
  if (upstreamRelease) {
    lines.push(`Upstream Nimbalyst ${upstreamRelease} is available (this build is based on ${facts.upstreamVersion}).`);
  }
  if (forkCommitsAhead > 0) {
    lines.push(`fork/main has ${forkCommitsAhead} commit${forkCommitsAhead === 1 ? '' : 's'} that this build does not include.`);
  }

  const keyParts: string[] = [];
  if (upstreamRelease) keyParts.push(`upstream:${upstreamRelease}`);
  if (forkCommitsAhead > 0) keyParts.push(`fork:${facts.forkHeadSha ?? forkCommitsAhead}`);

  return {
    upstreamRelease,
    forkCommitsAhead,
    incomplete,
    key: keyParts.length ? keyParts.join('|') : null,
    lines,
  };
}

/** Show the notification only for an out-of-date state not already notified. */
export function shouldNotify(status: ForkUpdateStatus, lastNotifiedKey: string | null): boolean {
  return status.key !== null && status.key !== lastNotifiedKey;
}
