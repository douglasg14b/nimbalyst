import React from 'react';
import { FORK_UPDATE_INSTRUCTIONS, getForkCommit } from '../../../../shared/forkBuild';

/**
 * Replaces the Release Channel section in fork builds (FORK.md). Fork builds
 * have no update channel: the built-in updater is inert and updates come from
 * the fork's own build and install scripts.
 */
export function ForkBuildSection(): React.ReactElement {
  return (
    <div className="fork-build-section provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
      <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Fork build</h4>
      <p className="text-sm leading-relaxed text-[var(--nim-text-muted)] mb-2">
        This is a fork build of Nimbalyst. Automatic updates and the release channel are turned off.
      </p>
      <p className="text-sm leading-relaxed text-[var(--nim-text-muted)] mb-2">
        Fork commit: <code className="fork-build-commit select-text text-[var(--nim-text)]">{getForkCommit()}</code>
      </p>
      <p className="text-xs leading-relaxed text-[var(--nim-text-faint)] m-0 select-text">{FORK_UPDATE_INSTRUCTIONS}</p>
    </div>
  );
}
