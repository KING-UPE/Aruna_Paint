import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Moon, Power } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';

interface ReadyUpdate {
  version: string;
  notes: string;
  choice: 'night' | 'startup' | null;
  installing: boolean;
  installAt: string;
}

/** The status bar's "Update ready" opens the pop-up again. */
export const OPEN_UPDATE_PROMPT = 'aruna:update-prompt';
const SNOOZE_KEY = 'aruna.updateSnooze';
const SNOOZE_MS = 2 * 3_600_000;

function snoozed(version: string): boolean {
  try {
    const s = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? 'null') as {
      version: string;
      until: number;
    } | null;
    return Boolean(s && s.version === version && s.until > Date.now());
  } catch {
    return false;
  }
}

/**
 * "Update ready": as soon as the shop server has downloaded a new version, the Super Admin or an
 * Admin is asked, on whatever screen they are, when to install it: now, tonight at the set time,
 * or when the shop server next starts. "Later" asks again in two hours. Updates never start in
 * the middle of someone's work without that choice, except tonight's automatic install.
 */
export function UpdatePrompt() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const managesUpdates =
    me.mode === 'shop' && (me.roles.includes('SUPER_ADMIN') || me.roles.includes('ADMIN'));
  // Same query as the status bar: one request every 15 s serves both.
  const system = useQuery({
    queryKey: ['system-status'],
    queryFn: () =>
      api.get<{ update?: ReadyUpdate | null }>('/api/system/status', { passive: true }),
    refetchInterval: 15_000,
    enabled: managesUpdates,
  });
  const update = system.data?.update ?? null;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const tonightRef = useRef<HTMLButtonElement>(null);
  const installAt = update?.installAt ?? '02:30';

  // Ask once a version is ready and nothing was chosen for it yet (and not snoozed).
  useEffect(() => {
    if (update && !update.choice && !update.installing && !snoozed(update.version)) setOpen(true);
  }, [update]);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_UPDATE_PROMPT, show);
    return () => window.removeEventListener(OPEN_UPDATE_PROMPT, show);
  }, []);

  if (!managesUpdates || !update) return null;

  const done = async () => {
    setOpen(false);
    await qc.invalidateQueries({ queryKey: ['system-status'] });
    await qc.invalidateQueries({ queryKey: ['updates'] });
  };
  const choose = async (when: 'night' | 'startup') => {
    setBusy(true);
    try {
      await api.post('/api/updates/choice', { when });
      toast.success(
        when === 'night'
          ? `Version ${update.version} installs tonight at ${installAt}.`
          : `Version ${update.version} installs the next time the shop server starts.`,
      );
      await done();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const installNow = async () => {
    setBusy(true);
    try {
      await api.post('/api/updates/install', {});
      toast.success(
        'Installing. Billing stops for a minute or two; the screens come back by themselves.',
      );
      await done();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const later = () => {
    try {
      localStorage.setItem(
        SNOOZE_KEY,
        JSON.stringify({ version: update.version, until: Date.now() + SNOOZE_MS }),
      );
    } catch {
      // Without storage it simply asks again on the next screen load.
    }
    setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? setOpen(true) : later())}
      title={`Update ready: version ${update.version}`}
      description="It is downloaded and checked. Choose when to install it."
      initialFocus={() => tonightRef.current}
      footer={
        <Button variant="ghost" disabled={busy} onClick={later}>
          Remind me later
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          While it installs, billing stops on every PC for a minute or two. A backup is made first,
          and the old version comes back by itself if anything goes wrong.
        </p>
        {update.notes ? (
          <details className="text-sm">
            <summary className="cursor-pointer text-accent-strong">What is new</summary>
            <p className="mt-1 whitespace-pre-wrap text-muted">{update.notes}</p>
          </details>
        ) : null}
        <div className="flex flex-col gap-2">
          <Button
            ref={tonightRef}
            variant="primary"
            icon={<Moon size={16} />}
            disabled={busy}
            onClick={() => void choose('night')}
          >
            Tonight at {installAt}
          </Button>
          <Button icon={<Power size={16} />} disabled={busy} onClick={() => void choose('startup')}>
            Next time the shop opens
          </Button>
          <Button icon={<Download size={16} />} disabled={busy} onClick={() => void installNow()}>
            Install now
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
