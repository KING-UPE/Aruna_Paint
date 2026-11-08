import { toast } from 'sonner';

/** The version these screens were built as (the root package.json, set by vite.config.ts). */
declare const __APP_VERSION__: string;
export const SCREENS_VERSION = __APP_VERSION__;

const EVERY_MS = 5 * 60_000;
const RELOADED_KEY = 'aruna-reloaded-for';
let pending = '';
let busy = false;
let notified = false;

/**
 * After an update the server runs the new version, but a screen left open still runs the old
 * one until it is reloaded. Each screen checks the server's version when it reconnects (the
 * server restarts after an update) and every few minutes, and reloads itself when they differ.
 */
export async function checkServerVersion(): Promise<void> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    if (!res.ok) return;
    const { version } = (await res.json()) as { version?: string };
    if (!version || version === SCREENS_VERSION) return;
    pending = version;
    // Once per server version: if a reload didn't bring the new screens, never loop.
    let reloadedFor: string | null = null;
    try {
      reloadedFor = sessionStorage.getItem(RELOADED_KEY);
    } catch {
      // no storage: reload anyway
    }
    if (!busy && reloadedFor !== version) {
      try {
        sessionStorage.setItem(RELOADED_KEY, version);
      } catch {
        // ignore
      }
      window.location.reload();
    } else if (!notified) {
      notified = true;
      // A bill being rung up lives only on this screen: never thrown away by a reload.
      toast.info(`Aruna POS was updated to ${version}.`, {
        description: busy
          ? 'The screen reloads by itself when this bill is finished.'
          : 'Reload the screen to use it.',
        duration: Infinity,
        action: { label: 'Reload now', onClick: () => window.location.reload() },
      });
    }
  } catch {
    // The server is restarting or unreachable: the next check tries again.
  }
}

/** A screen holding work that lives only on it (a bill being rung up) says so. */
export function setScreenBusy(isBusy: boolean): void {
  const wasBusy = busy;
  busy = isBusy;
  if (wasBusy && !busy && pending) void checkServerVersion();
}

/** Starts the regular check; returns the stop function. */
export function watchServerVersion(): () => void {
  void checkServerVersion();
  const timer = window.setInterval(() => void checkServerVersion(), EVERY_MS);
  // A window brought back (a PC woken up, a minimised window opened): check at once.
  const onShow = () => {
    if (document.visibilityState === 'visible') void checkServerVersion();
  };
  document.addEventListener('visibilitychange', onShow);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onShow);
  };
}
