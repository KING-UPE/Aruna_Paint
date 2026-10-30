import { formatDateTime } from '@aruna/shared';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConicalOff, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { useConfirm } from '@/components/AskDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import { api, errorMessage } from '@/lib/api';
import { useTestMode } from '@/lib/testMode';

/**
 * Super Admin only. Test mode is per user: the accounts switched on work on a copy of the data,
 * while everyone else keeps working on the real data. Accounts are switched from Users and roles.
 */
export function TestModeCard() {
  const { me } = useAuth();
  // Online: the copy is at the shop, so a refresh asked for here is done there.
  const online = me.mode === 'cloud';
  const q = useTestMode();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const status = q.data;

  const done = async () => {
    await qc.invalidateQueries({ queryKey: ['test-mode'] });
    await qc.invalidateQueries({ queryKey: ['users'] });
  };

  const backToReal = async (u: { id: string; fullName: string }) => {
    const ok = await confirm({
      title: `Put ${u.fullName} back on the real data?`,
      message: 'What they did in test mode stays in the test copy and never reaches the real data.',
      confirmLabel: 'Back to real data',
    });
    if (!ok) return;
    try {
      await api.post(`/api/users/${u.id}/test-mode`, { on: false });
      toast.success(`${u.fullName} is back on the real data.`);
      await done();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const refresh = async () => {
    const ok = await confirm({
      title: 'Make a fresh test copy?',
      message:
        'The test copy starts again from the real data as it is now. Everything done in test mode so far is thrown away.',
      confirmLabel: 'Refresh test copy',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.post('/api/test-mode/refresh', {});
      toast.success(
        online
          ? 'Asked. The shop makes a fresh test copy when it next connects; Cloud sync shows how it went.'
          : 'The test copy is fresh from the real data.',
      );
      await done();
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
        <Button
          size="sm"
          icon={<RefreshCw size={15} />}
          disabled={busy || (!online && !status?.copyMadeAt)}
          onClick={() => void refresh()}
        >
          {busy ? 'Making the copy…' : 'Refresh test copy'}
        </Button>
      </CardHeader>
      <CardBody className="flex flex-col gap-3 text-[15px]">
        <ul className="list-disc pl-5 text-muted">
          <li>
            Test mode is for single users. Switch an account on or off with the flask button in{' '}
            <Link to="/admin/users" className="font-medium text-accent-strong underline">
              Users and roles
            </Link>
            .
          </li>
          <li>
            Users in test mode work on a copy of the data: billing, stock, printing. Everyone else
            keeps working on the real data at the same time.
          </li>
          <li>
            Their receipts print &ldquo;TEST MODE - NOT A REAL BILL&rdquo;, numbers start with
            TEST-, the cash drawer does not open, and their screens show TEST MODE.
          </li>
          <li>Nothing done in test mode ever reaches the real data.</li>
        </ul>
        <div>
          <div className="mb-1.5 text-sm font-medium">In test mode now</div>
          {status?.users.length ? (
            <div className="flex flex-wrap gap-2">
              {status.users.map((u) => (
                <span
                  key={u.id}
                  className="inline-flex items-center gap-1 rounded-full border border-border py-0.5 pl-3 pr-0.5"
                >
                  <Badge tone="danger">Test</Badge>
                  <span>{u.fullName}</span>
                  <IconButton
                    label={`Put ${u.fullName} back on the real data`}
                    icon={<FlaskConicalOff size={15} />}
                    onClick={() => void backToReal(u)}
                  />
                </span>
              ))}
            </div>
          ) : (
            <p className="text-muted">Nobody. Everyone works on the real data.</p>
          )}
        </div>
        <p className="text-sm text-muted">
          {online
            ? 'The test copy is kept at the shop.'
            : status?.copyMadeAt
              ? `The test copy was made from the real data on ${formatDateTime(status.copyMadeAt)}.`
              : 'The test copy is made from the real data when the first user is put in test mode.'}
        </p>
      </CardBody>
    </Card>
  );
}
