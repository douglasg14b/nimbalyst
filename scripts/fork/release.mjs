#!/usr/bin/env node
// Publish the last smoke-tested fork build as a GitHub Release on your fork.
// See FORK.md.
//
//   node scripts/fork/release.mjs [--notes-file <file>] [--gh-user <login>] [--dry-run]
//
// - Publishes only the build of HEAD on fork/main, with a clean tree, that
//   passed smoke-test.mjs, whose installer still has the recorded SHA-256, and
//   whose commit is already on origin/fork/main (push.mjs first).
// - Tags the commit fork-v<upstream version>-<n> (n counts fork releases of that
//   upstream version). Never a v* tag: those are upstream's, and the scripts
//   find the upstream base with `git describe --match v*`.
// - Writes only to origin, as the account that owns it; refuses an origin that
//   is upstream, and never falls back to the active gh account.
// - Assets: the installer, SHA256SUMS.txt and fork-build.json. Never
//   latest.yml or blockmaps: the build's app-update.yml names this fork, and
//   those files would turn its releases into an update feed.
// - Safe to re-run after a failure: a tag already on HEAD is reused, and only
//   missing assets are uploaded.
// - Installing stays separate (install.mjs, with Nimbalyst closed).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { currentPlatform } from './lib/platform.mjs';
import {
  FORK_STATE_DIR, GIT_GH_AUTH, LAST_BUILD_FILE, LAST_SMOKE_FILE, capture, dirtyFiles, forkOwnerEnv, git, info,
  lowerPriority, originRepo, parseArgs, readJsonIfExists, run, runMain, sha256File, step, stop,
} from './lib/util.mjs';

const USAGE = 'node scripts/fork/release.mjs [--notes-file <file>] [--gh-user <login>] [--dry-run]';
const UPSTREAM_RELEASES = 'https://github.com/nimbalyst/nimbalyst/releases/tag';

const succeeds = (cmd, args, opts) => capture(cmd, args, { ...opts, allowFailure: true }).status === 0;
const tagCommit = (tag) => capture('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { allowFailure: true }).stdout || null;

runMain(async () => {
  const args = parseArgs(process.argv.slice(2), {
    notesFile: { type: 'string', default: null },
    ghUser: { type: 'string', default: null },
    dryRun: { type: 'boolean', default: false },
  });
  if (args.help) { console.log(USAGE); return 0; }

  step('Checking the build');
  const platform = currentPlatform();
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'fork/main') stop(`check out fork/main first (on '${branch}').`);
  const dirty = dirtyFiles();
  if (dirty.length) stop(`uncommitted changes in ${dirty.join(', ')}.`);
  const head = git('rev-parse', 'HEAD');
  const lastBuild = readJsonIfExists(LAST_BUILD_FILE);
  if (!lastBuild) stop('no build recorded. Run node scripts/fork/update.mjs first.');
  if (lastBuild.commit !== head) stop(`the last build is of ${lastBuild.commit.slice(0, 9)}, not HEAD ${head.slice(0, 9)}. Run node scripts/fork/update.mjs first.`);
  if (lastBuild.platform !== platform.id) stop(`the last build is for ${lastBuild.platform}, not ${platform.id}.`);
  const smoke = readJsonIfExists(LAST_SMOKE_FILE);
  if (!smoke || smoke.commit !== head || smoke.installerSha256 !== lastBuild.sha256) stop('this build has not passed node scripts/fork/smoke-test.mjs.');
  if (!existsSync(lastBuild.installer)) stop(`installer not found: ${lastBuild.installer}`);
  const sha256 = await sha256File(lastBuild.installer);
  if (sha256 !== lastBuild.sha256) stop(`the installer's SHA-256 ${sha256} no longer matches the build record ${lastBuild.sha256}. Rebuild.`);
  const installerName = path.basename(lastBuild.installer);
  info(`Build ${head.slice(0, 9)} of upstream ${lastBuild.upstreamVersion}, smoke-tested ${smoke.passedAt}`);

  step('Checking the fork on GitHub');
  const { owner, repo } = originRepo();
  const fullRepo = `${owner}/${repo}`;
  const env = forkOwnerEnv(args.ghUser ?? owner);
  run('git', [...GIT_GH_AUTH, 'fetch', 'origin', 'refs/tags/fork-v*:refs/tags/fork-v*'], { env });
  const fetched = succeeds('git', [...GIT_GH_AUTH, 'fetch', 'origin', '+refs/heads/fork/main:refs/remotes/origin/fork/main'], { env });
  if (!fetched || !succeeds('git', ['merge-base', '--is-ancestor', head, 'origin/fork/main'])) {
    stop(`${fullRepo} fork/main does not contain ${head.slice(0, 9)}. Push first: node scripts/fork/push.mjs`);
  }

  const version = lastBuild.upstreamVersion;
  const prefix = `fork-v${version}-`;
  const existing = capture('git', ['tag', '--list', `${prefix}*`]).split(/\r?\n/).filter(Boolean);
  let tag = existing.find((t) => tagCommit(t) === head) ?? null;
  const reuse = !!tag;
  if (!tag) {
    const numbers = existing.map((t) => Number(t.slice(prefix.length))).filter(Number.isInteger);
    tag = `${prefix}${Math.max(0, ...numbers) + 1}`;
  }
  const buildNumber = tag.slice(prefix.length);
  info(reuse ? `Reusing tag ${tag}, already on this commit.` : `New tag ${tag}.`);

  const view = capture('gh', ['release', 'view', tag, '-R', fullRepo, '--json', 'url,assets'], { env, allowFailure: true });
  const release = view.status === 0 ? JSON.parse(view.stdout) : null;
  info(release ? `Release exists: ${release.url}` : 'No release for this tag yet.');

  step('Preparing the assets and notes');
  const dir = path.join(FORK_STATE_DIR, 'release', tag);
  mkdirSync(dir, { recursive: true });
  const sumsFile = path.join(dir, 'SHA256SUMS.txt');
  writeFileSync(sumsFile, `${sha256.toLowerCase()}  ${installerName}\n`);
  // No local paths: they carry the user's profile folder.
  const recordFile = path.join(dir, 'fork-build.json');
  writeFileSync(recordFile, `${JSON.stringify({
    tag, platform: lastBuild.platform, upstreamVersion: version, exeVersion: lastBuild.exeVersion, commit: head,
    installer: installerName, sha256, sizeBytes: lastBuild.sizeBytes, builtAt: lastBuild.builtAt,
  }, null, 2)}\n`);

  const previous = capture('git', ['describe', '--tags', '--abbrev=0', '--match', 'fork-v*', '--exclude', tag, 'HEAD'], { allowFailure: true }).stdout || null;
  const base = previous ?? (tagCommit(`v${version}`) ? `v${version}` : null);
  const changes = base ? capture('git', ['log', '--first-parent', '--format=- %s (%h)', `${base}..HEAD`]).split(/\r?\n/).filter(Boolean) : [];
  const extra = args.notesFile ? `${readFileSync(args.notesFile, 'utf8').trim()}\n\n` : '';
  const notesFile = path.join(dir, 'notes.md');
  writeFileSync(notesFile, `${extra}Personal fork build of Nimbalyst ${version}, based on the upstream release [v${version}](${UPSTREAM_RELEASES}/v${version}).

- Fork commit: \`${head}\`
- Installer: \`${installerName}\` (${platform.displayName}), unsigned, SHA-256 \`${sha256}\`
- The app never downloads or installs fork releases by itself.

To install: quit Nimbalyst, then from the fork checkout that built it, \`node scripts/fork/install.mjs\` (see FORK.md). On another machine, build there with \`node scripts/fork/update.mjs\`; \`install.mjs\` does not accept a downloaded installer yet. Running the downloaded installer directly also upgrades in place and keeps app data, but takes no backup.

${base ? `First-parent history since ${base}:` : 'History:'}
${changes.slice(0, 60).join('\n') || '- (none)'}${changes.length > 60 ? `\n- ... and ${changes.length - 60} more` : ''}
`);

  const assets = [lastBuild.installer, sumsFile, recordFile];
  const present = new Set((release?.assets ?? []).map((a) => a.name));
  const missing = assets.filter((a) => !present.has(path.basename(a)));
  info(`Repository: ${fullRepo}`);
  info(`Title:      Nimbalyst ${version} (fork build ${buildNumber})`);
  info(`Assets:     ${assets.map((a) => path.basename(a)).join(', ')}${release ? ` (to upload: ${missing.map((a) => path.basename(a)).join(', ') || 'none'})` : ''}`);
  info(`Notes:      ${notesFile}`);

  if (args.dryRun) {
    console.log(`\n${readFileSync(notesFile, 'utf8')}`);
    info('Dry run: no tag, push or release was made.');
    return 0;
  }

  lowerPriority();
  if (!tagCommit(tag)) {
    step(`Tagging ${head.slice(0, 9)} as ${tag}`);
    git('tag', '-a', tag, '-m', `Nimbalyst ${version}, fork build ${buildNumber}`, head);
  }
  if (!succeeds('git', [...GIT_GH_AUTH, 'ls-remote', '--exit-code', 'origin', `refs/tags/${tag}`], { env })) {
    step(`Pushing ${tag} to ${fullRepo}`);
    run('git', [...GIT_GH_AUTH, 'push', 'origin', `refs/tags/${tag}`], { env });
  }
  if (!release) {
    step(`Creating the release (uploading ${installerName}, ${Math.round(lastBuild.sizeBytes / 1024 ** 2)} MB)`);
    run('gh', ['release', 'create', tag, '-R', fullRepo, '--verify-tag', '--title', `Nimbalyst ${version} (fork build ${buildNumber})`, '--notes-file', notesFile, ...assets], { env });
  } else if (missing.length) {
    step(`Uploading ${missing.map((a) => path.basename(a)).join(', ')}`);
    run('gh', ['release', 'upload', tag, '-R', fullRepo, '--clobber', ...missing], { env });
  }
  const url = capture('gh', ['release', 'view', tag, '-R', fullRepo, '--json', 'url', '--jq', '.url'], { env });
  console.log(`\nPublished ${tag}: ${url}`);
  return 0;
});
