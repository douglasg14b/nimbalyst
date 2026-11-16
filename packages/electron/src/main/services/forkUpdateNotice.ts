import { app, BrowserWindow, dialog, net, Notification } from 'electron';
import log from 'electron-log/main';
import * as fs from 'fs';
import * as path from 'path';
import { FORK_UPDATE_INSTRUCTIONS, getForkCommit, getForkRepo } from '../../shared/forkBuild';
import { planForkUpdateStatus, shouldNotify, type ForkUpdateStatus } from './forkUpdateStatus';

/**
 * "Update available" notice for fork builds (FORK.md). It only tells you;
 * nothing is downloaded or installed. Checks GitHub twice a day:
 * - upstream's latest stable release vs the version this build is based on;
 * - the fork's fork/main vs the commit this build was made from.
 * Every failure is logged and swallowed; a notice must never break the app.
 */

const UPSTREAM_LATEST_RELEASE = 'https://api.github.com/repos/nimbalyst/nimbalyst/releases/latest';
const FIRST_CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const STATE_FILE = 'fork-update-notice.json';

let interval: NodeJS.Timeout | null = null;

async function getJson(url: string): Promise<any> {
  const response = await net.fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nimbalyst-fork-update-notice' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

async function fetchLatestUpstreamTag(): Promise<string | null> {
  try {
    const release = await getJson(UPSTREAM_LATEST_RELEASE);
    return typeof release?.tag_name === 'string' ? release.tag_name : null;
  } catch (error) {
    log.warn('[fork] Could not check upstream releases:', error);
    return null;
  }
}

async function fetchForkAhead(): Promise<{ ahead: number | null; headSha: string | null }> {
  const repo = getForkRepo();
  const commit = getForkCommit();
  if (!repo || !/^[0-9a-f]{40}$/.test(commit)) return { ahead: null, headSha: null };
  try {
    const compare = await getJson(`https://api.github.com/repos/${repo}/compare/${commit}...fork%2Fmain`);
    const commits: Array<{ sha?: string }> = Array.isArray(compare?.commits) ? compare.commits : [];
    return {
      ahead: typeof compare?.ahead_by === 'number' ? compare.ahead_by : null,
      headSha: commits.length ? commits[commits.length - 1].sha ?? null : commit,
    };
  } catch (error) {
    log.warn('[fork] Could not compare with the fork on GitHub:', error);
    return { ahead: null, headSha: null };
  }
}

export async function checkForkUpdateStatus(): Promise<ForkUpdateStatus> {
  const [latestUpstreamTag, fork] = await Promise.all([fetchLatestUpstreamTag(), fetchForkAhead()]);
  return planForkUpdateStatus({
    upstreamVersion: app.getVersion(),
    latestUpstreamTag,
    forkCommitsAhead: fork.ahead,
    forkHeadSha: fork.headSha,
  });
}

function stateFilePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function readLastNotifiedKey(): string | null {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(), 'utf8')).lastNotifiedKey ?? null;
  } catch {
    return null;
  }
}

function writeLastNotifiedKey(key: string): void {
  try {
    fs.writeFileSync(stateFilePath(), JSON.stringify({ lastNotifiedKey: key, notifiedAt: new Date().toISOString() }));
  } catch (error) {
    log.warn('[fork] Could not record the update notice:', error);
  }
}

async function checkAndNotify(): Promise<void> {
  try {
    const status = await checkForkUpdateStatus();
    if (!shouldNotify(status, readLastNotifiedKey())) return;
    log.info(`[fork] Update available: ${status.lines.join(' ')}`);
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: 'Nimbalyst fork: update available',
        body: `${status.lines.join(' ')} Run node scripts/fork/update.mjs in the fork checkout.`,
      });
      notification.on('click', () => {
        void showForkUpdateDialog(BrowserWindow.getFocusedWindow());
      });
      notification.show();
    }
    writeLastNotifiedKey(status.key!);
  } catch (error) {
    log.warn('[fork] Update notice check failed:', error);
  }
}

/** Start the background checks. Called once, after app ready. */
export function startForkUpdateNotice(): void {
  if (interval) return;
  setTimeout(() => void checkAndNotify(), FIRST_CHECK_DELAY_MS);
  interval = setInterval(() => void checkAndNotify(), CHECK_INTERVAL_MS);
}

/** "Check for Updates..." in fork builds: show the current status and how to update. */
export async function showForkUpdateDialog(window: BrowserWindow | null): Promise<void> {
  let summary: string;
  try {
    const status = await checkForkUpdateStatus();
    if (status.lines.length) {
      summary = status.lines.join('\n');
    } else if (status.incomplete) {
      summary = 'Could not reach GitHub to check for updates.';
    } else {
      summary = 'Up to date: no newer upstream release, and fork/main has nothing this build lacks.';
    }
  } catch (error) {
    log.warn('[fork] Update check for the dialog failed:', error);
    summary = 'Could not check for updates.';
  }
  const options = {
    type: 'info' as const,
    title: 'Check for Updates',
    message: 'This is a fork build of Nimbalyst.',
    detail: `${summary}\n\nBuilt from fork commit ${getForkCommit()}, based on Nimbalyst ${app.getVersion()}.\n\n${FORK_UPDATE_INSTRUCTIONS}`,
  };
  await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
}
