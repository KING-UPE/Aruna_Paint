import { DEFAULT_SHORTCUTS, eventToCombo, type ShortcutScreen } from '@aruna/shared';
import { KeyRound, RotateCcw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { ChangePasswordPage } from '@/auth/ChangePasswordPage';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { PageHeader } from '@/components/ui/misc';
import { useKeymap } from '@/keyboard/keymap';
import { api, errorMessage } from '@/lib/api';

const SCREENS: { screen: ShortcutScreen; title: string }[] = [
  { screen: 'global', title: 'Everywhere' },
  { screen: 'billing', title: 'Billing' },
  { screen: 'bill_history', title: 'Bill history' },
];

/**
 * Each user can remap any shortcut and save their own key map. A key already used on that
 * screen, or one the browser reserves, can't be assigned. "Reset to default" brings them back.
 */
export function ProfilePage() {
  const { me } = useAuth();
  const { maps } = useKeymap();
  const qc = useQueryClient();
  const [capture, setCapture] = useState<{ screen: ShortcutScreen; action: string } | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const captureRef = useRef<HTMLDivElement>(null);
  const save = async (screen: ShortcutScreen, action: string, keys: string) => {
    try {
      await api.put('/api/auth/shortcuts', { screen, action, keys });
      toast.success(`${DEFAULT_SHORTCUTS[screen][action]?.label}: ${keys}`);
      await qc.invalidateQueries({ queryKey: ['me'] });
      setCapture(null);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="My profile" description={`${me.user.fullName} · ${me.user.username}`}>
        <Button icon={<KeyRound size={16} />} onClick={() => setPasswordOpen(true)}>
          Change password
        </Button>
        <Button
          icon={<RotateCcw size={16} />}
          onClick={async () => {
            await api.delete('/api/auth/shortcuts');
            await qc.invalidateQueries({ queryKey: ['me'] });
            toast.success('Keys reset to the defaults.');
          }}
        >
          Reset keys to default
        </Button>
      </PageHeader>
      <div className="grid gap-4 lg:grid-cols-3">
        {SCREENS.map(({ screen, title }) => (
          <Card key={screen}>
            <CardHeader>
              <CardTitle>{title}</CardTitle>
            </CardHeader>
            <CardBody className="p-0">
              <ul className="divide-y divide-border">
                {Object.entries(DEFAULT_SHORTCUTS[screen]).map(([action, def]) => (
                  <li key={action} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span>{def.label}</span>
                    <button
                      className="rounded px-1 hover:bg-surface-2"
                      onClick={() => setCapture({ screen, action })}
                      aria-label={`Change key for ${def.label}`}
                    >
                      <Kbd>{maps[screen][action]}</Kbd>
                    </button>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        ))}
      </div>
      <Dialog
        open={Boolean(capture)}
        onOpenChange={(o) => (!o ? setCapture(null) : undefined)}
        title="Press the new key"
        description={capture ? DEFAULT_SHORTCUTS[capture.screen][capture.action]?.label : ''}
        initialFocus={() => captureRef.current}
      >
        <div
          ref={captureRef}
          tabIndex={0}
          className="rounded-[var(--radius-card)] border-2 border-dashed border-accent p-8 text-center text-muted outline-none"
          onKeyDown={(e) => {
            if (!capture) return;
            if (e.key === 'Escape') return;
            const combo = eventToCombo(e.nativeEvent);
            if (!combo) return;
            e.preventDefault();
            e.stopPropagation();
            void save(capture.screen, capture.action, combo);
          }}
        >
          Press a key or a combination like Ctrl+9. Esc cancels.
        </div>
      </Dialog>
      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen} title="Change password">
        <ChangePasswordPage
          forced={false}
          onDone={() => (setPasswordOpen(false), toast.success('Password changed.'))}
        />
      </Dialog>
    </div>
  );
}
