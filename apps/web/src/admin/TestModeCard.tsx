import { formatDateTime, formatTime } from '@aruna/shared';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Undo2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useConfirm } from '@/components/AskDialog';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useTestMode } from '@/lib/testMode';

const HOURS = [
  { value: '0.5', label: '30 minutes' },
  { value: '1', label: '1 hour' },
  { value: '2', label: '2 hours' },
  { value: '4', label: '4 hours' },
  { value: '8', label: '8 hours' },
];

/** Super Admin only: try the whole system on a copy of the data, then go back to the real data. */
export function TestModeCard() {
  const q = useTestMode();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [hours, setHours] = useState('1');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const status = q.data;

  // Every screen reloads: the data underneath has changed.
  const refresh = () => qc.invalidateQueries();

  const turnOn = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!password) return setError('Type your password.');
    setBusy(true);
    try {
      await api.post('/api/test-mode/on', { password, hours: Number(hours) });
      setPassword('');
      toast.success('Test mode is on. Nothing done now is kept.');
      await refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.field === 'password' ? 'Wrong password.' : errorMessage(err),
      );
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    const ok = await confirm({
      title: 'Go back to the real data?',
      message:
        'Everything done in test mode is thrown away. The real data carries on from where it stopped.',
      confirmLabel: 'Turn test mode off',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.post('/api/test-mode/off', {});
      toast.success('Back to the real data.');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Test mode</CardTitle>
      </CardHeader>
      <CardBody className="flex flex-col gap-3 text-[15px]">
        {status?.on ? (
          <>
            <p className="font-semibold text-danger">
              Test mode is on: since {formatDateTime(status.since!)}
              {status.byName ? `, turned on by ${status.byName}` : ''}. It ends by itself at{' '}
              {formatTime(status.until!)}.
            </p>
            <p className="text-muted">
              Bills, stock and everything else work as normal but on a copy. Turning it off goes
              back to the real data exactly where it stopped.
            </p>
            <div>
              <Button
                variant="danger"
                icon={<Undo2 size={16} />}
                disabled={busy}
                onClick={() => void turnOff()}
              >
                Turn test mode off
              </Button>
            </div>
          </>
        ) : (
          <>
            <ul className="list-disc pl-5 text-muted">
              <li>The whole system works on a copy of the data: billing, stock, printing.</li>
              <li>
                Receipts print &ldquo;TEST MODE - NOT A REAL BILL&rdquo;, numbers start with TEST-,
                and the cash drawer does not open. Backups pause.
              </li>
              <li>
                Turning it off goes back to the real data exactly where it stopped. Nothing done in
                test mode is kept.
              </li>
              <li>It turns itself off after the time you choose, so real sales are never lost.</li>
            </ul>
            <form onSubmit={turnOn} className="grid gap-3 md:grid-cols-3 md:items-end">
              <Field label="Turn off by itself after" htmlFor="test-mode-hours">
                <Select
                  id="test-mode-hours"
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                >
                  {HOURS.map((h) => (
                    <option key={h.value} value={h.value}>
                      {h.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Your password" htmlFor="test-mode-password" error={error || undefined}>
                <Input
                  id="test-mode-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <div className={error ? 'md:self-center' : undefined}>
                <Button
                  type="submit"
                  variant="primary"
                  icon={<FlaskConical size={16} />}
                  disabled={busy}
                >
                  {busy ? 'Making the test copy…' : 'Turn test mode on'}
                </Button>
              </div>
            </form>
          </>
        )}
      </CardBody>
    </Card>
  );
}
