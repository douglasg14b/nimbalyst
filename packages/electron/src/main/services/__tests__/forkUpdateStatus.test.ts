// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { isNewerVersion, planForkUpdateStatus, shouldNotify } from '../forkUpdateStatus';

const base = { upstreamVersion: '0.83.0', latestUpstreamTag: 'v0.83.0', forkCommitsAhead: 0, forkHeadSha: 'aaa' };

describe('fork update status', () => {
  it('compares plain versions and never treats prereleases or junk as newer', () => {
    expect(isNewerVersion('v0.84.1', '0.83.0')).toBe(true);
    expect(isNewerVersion('v0.83.10', '0.83.9')).toBe(true);
    expect(isNewerVersion('v0.83.0', '0.83.0')).toBe(false);
    expect(isNewerVersion('v0.82.8', '0.83.0')).toBe(false);
    expect(isNewerVersion('v0.84.0-alpha.1', '0.83.0')).toBe(false);
    expect(isNewerVersion('garbage', '0.83.0')).toBe(false);
  });

  it('is up to date when upstream has nothing newer and fork/main has no new commits', () => {
    const status = planForkUpdateStatus(base);
    expect(status).toMatchObject({ upstreamRelease: null, forkCommitsAhead: 0, incomplete: false, key: null });
    expect(shouldNotify(status, null)).toBe(false);
  });

  it('reports a newer upstream release and new fork commits, once per state', () => {
    const status = planForkUpdateStatus({ ...base, latestUpstreamTag: 'v0.84.1', forkCommitsAhead: 3, forkHeadSha: 'bbb' });
    expect(status.upstreamRelease).toBe('v0.84.1');
    expect(status.forkCommitsAhead).toBe(3);
    expect(status.lines).toHaveLength(2);
    expect(shouldNotify(status, null)).toBe(true);
    expect(shouldNotify(status, status.key)).toBe(false);

    // A new fork/main head after the notice was shown is a new state.
    const later = planForkUpdateStatus({ ...base, latestUpstreamTag: 'v0.84.1', forkCommitsAhead: 4, forkHeadSha: 'ccc' });
    expect(shouldNotify(later, status.key)).toBe(true);
  });

  it('marks the status incomplete when a check failed, without inventing an update', () => {
    const status = planForkUpdateStatus({ ...base, latestUpstreamTag: null, forkCommitsAhead: null, forkHeadSha: null });
    expect(status).toMatchObject({ upstreamRelease: null, forkCommitsAhead: 0, incomplete: true, key: null });
  });
});
