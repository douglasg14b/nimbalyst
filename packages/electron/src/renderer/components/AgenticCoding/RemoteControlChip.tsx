/**
 * RemoteControlChip — drive a Claude Agent session from claude.ai/code or the
 * Claude mobile app (GH #1480).
 *
 * The bridge lives in the provider and survives between turns. This chip shows
 * its honest state, and its popover holds the pairing link (copy, open, QR
 * code) and the on/off control. `/rc` in the composer does the same through the
 * same IPC.
 *
 * Pull on mount, push for transitions: the central listener writes
 * remoteControlAtomFamily, and this reads it.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import QRCode from 'qrcode';
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { copyToClipboard } from '@nimbalyst/runtime/utils/clipboard';
import {
  REMOTE_CONTROL_PROVIDERS,
  remoteControlAtomFamily,
  type RemoteControlCommandResult,
  type RemoteControlSnapshot,
  type RemoteControlState,
} from '../../store/atoms/remoteControl';
import { sessionStoreAtom } from '../../store/atoms/sessions';

interface RemoteControlChipProps {
  sessionId: string;
  provider: string;
}

const STATE_LABEL: Record<RemoteControlState, string> = {
  off: 'Off',
  connecting: 'Connecting',
  ready: 'Ready, waiting for your phone or browser',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  disconnected: 'Paused: reconnects on this session\'s next message',
  error: 'Could not start',
};

function chipLabel(state: RemoteControlState, busy: boolean): string {
  if (busy || state === 'connecting' || state === 'reconnecting') return 'Remote...';
  if (state === 'connected') return 'Remote on';
  if (state === 'ready') return 'Remote ready';
  if (state === 'disconnected') return 'Remote paused';
  return 'Remote';
}

function tone(state: RemoteControlState, desired: boolean): 'on' | 'warn' | 'error' | 'off' {
  if (state === 'error') return 'error';
  if (!desired) return 'off';
  if (state === 'ready' || state === 'connected') return 'on';
  return 'warn';
}

const CHIP_CLASS = {
  on: 'border-green-500/45 bg-green-500/10 text-green-600',
  warn: 'border-amber-500/45 bg-amber-500/10 text-amber-500',
  error: 'border-red-500/45 bg-red-500/10 text-red-500',
  off: 'border-[var(--nim-border)] text-[var(--nim-text-muted)]',
} as const;

const DOT_CLASS = {
  on: 'bg-green-500',
  warn: 'bg-amber-500',
  error: 'bg-red-500',
  off: 'bg-[var(--nim-text-faint)]',
} as const;

export function RemoteControlChip({ sessionId, provider }: RemoteControlChipProps) {
  const supported = REMOTE_CONTROL_PROVIDERS.has(provider);
  const status = useAtomValue(remoteControlAtomFamily(sessionId));
  const setStatus = useSetAtom(remoteControlAtomFamily(sessionId));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!supported) return;
    try {
      const next: RemoteControlSnapshot = await window.electronAPI.invoke('ai:remote-control:get', { sessionId, provider });
      if (next?.sessionId) setStatus(next);
    } catch {
      // Keep the last pushed state rather than blanking a control in use.
    }
  }, [supported, sessionId, provider, setStatus]);

  // Pull on mount: before this session's first turn no push has happened yet.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const floating = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });
  const click = useClick(floating.context);
  const dismiss = useDismiss(floating.context);
  const role = useRole(floating.context, { role: 'dialog' });
  const { getReferenceProps, getFloatingProps } = useInteractions([click, dismiss, role]);

  const sessionUrl = status?.desired ? status.sessionUrl : null;
  useEffect(() => {
    if (!open || !sessionUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(sessionUrl, {
      width: 200,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    })
      .then((url: string) => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { if (!cancelled) setQrDataUrl(null); });
    return () => { cancelled = true; };
  }, [open, sessionUrl]);

  const runCommand = useCallback(async (channel: 'ai:remote-control:enable' | 'ai:remote-control:disable') => {
    if (busy) return;
    setBusy(true);
    setCommandError(null);
    try {
      const result: RemoteControlCommandResult = await window.electronAPI.invoke(channel, { sessionId, provider });
      if (result?.snapshot?.sessionId) setStatus(result.snapshot);
      if (result && !result.success) setCommandError(result.error ?? 'Remote Control failed.');
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [busy, sessionId, provider, setStatus]);

  const copyUrl = useCallback(() => {
    if (!sessionUrl) return;
    copyToClipboard(sessionUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [sessionUrl]);

  // Hidden, not disabled, where it can never work (Codex, the claude-code-cli
  // terminal mode): a dead control would read as a broken feature.
  if (!supported) return null;
  // Nothing known yet, or a session with no live provider that does not want
  // Remote Control: there is no process to bridge until it runs a turn.
  if (!status || (!status.active && !status.desired)) return null;

  const state: RemoteControlState = status.desired ? status.state : status.state === 'error' ? 'error' : 'off';
  const chipTone = commandError ? 'error' : tone(state, status.desired);
  const error = commandError ?? status.error;

  return (
    <>
      <button
        ref={floating.refs.setReference}
        {...getReferenceProps()}
        className={`remote-control-chip shrink-0 inline-flex items-center gap-1.5 h-6 px-2 rounded-full border text-[0.6875rem] font-medium bg-transparent cursor-pointer transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] ${CHIP_CLASS[chipTone]}`}
        title="Remote Control: continue this session from claude.ai or the Claude app"
        data-testid="remote-control-chip"
        data-state={state}
      >
        <span className={`remote-control-chip-dot w-1.5 h-1.5 rounded-full ${DOT_CLASS[chipTone]}`} />
        {chipLabel(state, busy)}
      </button>

      {open && (
        <FloatingPortal>
          <div
            ref={floating.refs.setFloating}
            style={floating.floatingStyles}
            {...getFloatingProps()}
            className="remote-control-popover z-50 w-72 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-elevated,var(--nim-bg))] shadow-lg p-3 flex flex-col gap-2"
            data-testid="remote-control-popover"
          >
            <div className="remote-control-popover-head flex items-baseline justify-between gap-2">
              <span className="remote-control-popover-title text-xs font-semibold text-[var(--nim-text)]">Remote Control</span>
              <span className="remote-control-popover-state text-[0.6875rem] text-[var(--nim-text-muted)]" data-testid="remote-control-state">
                {STATE_LABEL[state]}
              </span>
            </div>

            {error && (
              <div className="remote-control-popover-error text-[0.6875rem] text-red-500 select-text" data-testid="remote-control-error">
                {error}
              </div>
            )}

            {sessionUrl ? (
              <>
                <div className="remote-control-popover-url flex items-center gap-1">
                  <span className="remote-control-popover-url-text min-w-0 flex-1 truncate text-[0.6875rem] text-[var(--nim-text)] select-text" title={sessionUrl}>
                    {sessionUrl}
                  </span>
                  <button
                    type="button"
                    onClick={copyUrl}
                    className="remote-control-popover-copy shrink-0 h-6 px-2 rounded border border-[var(--nim-border)] text-[0.6875rem] text-[var(--nim-text-muted)] bg-transparent cursor-pointer hover:bg-[var(--nim-bg-hover)]"
                    data-testid="remote-control-copy"
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.electronAPI.openExternal?.(sessionUrl)}
                    className="remote-control-popover-open shrink-0 h-6 px-2 rounded border border-[var(--nim-border)] text-[0.6875rem] text-[var(--nim-text-muted)] bg-transparent cursor-pointer hover:bg-[var(--nim-bg-hover)]"
                    data-testid="remote-control-open"
                  >
                    Open
                  </button>
                </div>
                {qrDataUrl && (
                  <img
                    src={qrDataUrl}
                    alt="QR code for the Remote Control session link"
                    className="remote-control-popover-qr self-center w-40 h-40 rounded"
                    data-testid="remote-control-qr"
                  />
                )}
              </>
            ) : (
              <div className="remote-control-popover-hint text-[0.6875rem] leading-snug text-[var(--nim-text-faint)]">
                Turn it on to get a link and QR code for claude.ai/code or the Claude app. You can also type /rc in the composer.
              </div>
            )}

            <div className="remote-control-popover-actions flex justify-end">
              {status.desired ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runCommand('ai:remote-control:disable')}
                  className="remote-control-popover-disable h-7 px-3 rounded border border-[var(--nim-border)] text-xs text-[var(--nim-text)] bg-transparent cursor-pointer hover:bg-[var(--nim-bg-hover)] disabled:opacity-60 disabled:cursor-default"
                  data-testid="remote-control-disable"
                >
                  Turn off
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void runCommand('ai:remote-control:enable')}
                  className="remote-control-popover-enable h-7 px-3 rounded border border-[var(--nim-primary)] text-xs text-[var(--nim-primary)] bg-transparent cursor-pointer hover:bg-[var(--nim-bg-hover)] disabled:opacity-60 disabled:cursor-default"
                  data-testid="remote-control-enable"
                >
                  {busy ? 'Starting...' : 'Turn on'}
                </button>
              )}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

/** Chip for the session the workstream header is showing; follows that session's provider. */
export function ActiveSessionRemoteControlChip({ sessionId }: { sessionId: string }) {
  const session = useAtomValue(sessionStoreAtom(sessionId));
  const provider = session?.provider;
  if (!provider || !REMOTE_CONTROL_PROVIDERS.has(provider)) return null;
  return <RemoteControlChip sessionId={sessionId} provider={provider} />;
}
