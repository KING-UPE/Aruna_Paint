import { formatDateTime } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Hash, KeyRound, Pencil, Plus, Trash2, UserCheck, UserX } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { useAsk, useConfirm } from '@/components/AskDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { EmptyState, PageHeader } from '@/components/ui/misc';
import { api, ApiError, errorMessage } from '@/lib/api';

interface Cashier {
  id: string;
  username: string;
  fullName: string;
  active: boolean;
  mustChangePassword: boolean;
  hasPin: boolean;
  lastLoginAt: string | null;
}

/**
 * Cashier management for Admins and the Super Admin (the shop's request): add a cashier, change
 * the name, reset the password or PIN, switch the account off or on, delete it. A cashier with
 * bills is switched off instead of deleted, so the old bills keep the name. Every other account
 * is the Super Admin's, in Users and roles.
 */
export function CashiersPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const ask = useAsk();
  const q = useQuery({
    queryKey: ['cashiers'],
    queryFn: () => api.get<{ items: Cashier[] }>('/api/cashiers'),
  });
  const [adding, setAdding] = useState(false);
  const canEdit = can('cashiers.edit');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['cashiers'] });
    void qc.invalidateQueries({ queryKey: ['users'] });
  };
  const run = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      toast.success(done);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const rename = async (c: Cashier) => {
    const name = await ask({
      title: `Change ${c.fullName}'s name`,
      label: 'Full name',
      initial: c.fullName,
      confirmLabel: 'Save',
    });
    if (name && name !== c.fullName)
      await run(() => api.patch(`/api/cashiers/${c.id}`, { fullName: name }), 'Name saved.');
  };
  const resetPassword = async (c: Cashier) => {
    const password = await ask({
      title: `Reset password for ${c.fullName}`,
      label: 'New password',
      hint: 'At least 8 characters. They change it at next login.',
      type: 'password',
      confirmLabel: 'Reset password',
      check: (v) => (v.length < 8 ? 'Use at least 8 characters.' : null),
    });
    if (password)
      await run(
        () => api.post(`/api/cashiers/${c.id}/reset-password`, { password }),
        'Password reset. They must change it at next login.',
      );
  };
  const resetPin = async (c: Cashier) => {
    const pin = await ask({
      title: `Reset PIN for ${c.fullName}`,
      label: 'New PIN',
      hint: '4 to 6 digits, unique per user.',
      type: 'password',
      inputMode: 'numeric',
      confirmLabel: 'Reset PIN',
      check: (v) => (/^\d{4,6}$/.test(v) ? null : 'A PIN has 4 to 6 digits.'),
    });
    if (pin) await run(() => api.post(`/api/cashiers/${c.id}/reset-pin`, { pin }), 'PIN reset.');
  };
  const switchActive = async (c: Cashier) => {
    if (c.active) {
      const ok = await confirm({
        title: `Switch off ${c.fullName}?`,
        message: 'They can no longer sign in. Their bills stay as they are.',
        confirmLabel: 'Switch off',
      });
      if (!ok) return;
    }
    await run(
      () => api.patch(`/api/cashiers/${c.id}`, { active: !c.active }),
      c.active ? `${c.fullName} is switched off.` : `${c.fullName} can sign in again.`,
    );
  };
  const remove = async (c: Cashier) => {
    const ok = await confirm({
      title: `Delete ${c.fullName}?`,
      message:
        'The account is removed. If they have bills, it is switched off instead, so their old bills keep their name.',
      confirmLabel: 'Delete cashier',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.delete<{ deleted: boolean }>(`/api/cashiers/${c.id}`);
      toast.success(
        r.deleted
          ? `${c.fullName} is deleted.`
          : `${c.fullName} has bills, so the account is switched off instead.`,
      );
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const items = q.data?.items ?? [];
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Cashiers"
        description="Cashier accounts. Other accounts are managed by the Super Admin."
      >
        {can('cashiers.create') ? (
          <Button variant="primary" icon={<Plus size={16} />} onClick={() => setAdding(true)}>
            Cashier
          </Button>
        ) : null}
      </PageHeader>
      <Card>
        <CardBody className="p-0">
          {items.length === 0 ? (
            <EmptyState title={q.isLoading ? 'Loading…' : 'No cashiers yet.'} />
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Username</th>
                  <th className="px-4 py-2 font-medium">PIN</th>
                  <th className="px-4 py-2 font-medium">Last sign-in</th>
                  <th className="px-4 py-2 font-medium">State</th>
                  {canEdit ? (
                    <th className="px-2 py-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {items.map((c) => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-4 py-2 font-medium">{c.fullName}</td>
                    <td className="px-4 py-2 font-mono">{c.username}</td>
                    <td className="px-4 py-2 text-muted">{c.hasPin ? 'Set' : 'None'}</td>
                    <td className="px-4 py-2 text-muted">
                      {c.lastLoginAt ? formatDateTime(c.lastLoginAt) : 'Never'}
                    </td>
                    <td className="px-4 py-2">
                      {!c.active ? (
                        <Badge tone="neutral">Switched off</Badge>
                      ) : c.mustChangePassword ? (
                        <Badge tone="warn">New password due</Badge>
                      ) : (
                        <Badge tone="ok">Active</Badge>
                      )}
                    </td>
                    {canEdit ? (
                      <td className="px-2 py-1">
                        <div className="flex justify-end gap-0.5">
                          <IconButton
                            label={`Change ${c.fullName}'s name`}
                            icon={<Pencil size={15} />}
                            onClick={() => void rename(c)}
                          />
                          <IconButton
                            label={`Reset password for ${c.fullName}`}
                            icon={<KeyRound size={15} />}
                            onClick={() => void resetPassword(c)}
                          />
                          <IconButton
                            label={`Reset PIN for ${c.fullName}`}
                            icon={<Hash size={15} />}
                            onClick={() => void resetPin(c)}
                          />
                          <IconButton
                            label={
                              c.active ? `Switch off ${c.fullName}` : `Switch on ${c.fullName}`
                            }
                            icon={c.active ? <UserX size={15} /> : <UserCheck size={15} />}
                            onClick={() => void switchActive(c)}
                          />
                          <IconButton
                            label={`Delete ${c.fullName}`}
                            icon={<Trash2 size={15} />}
                            onClick={() => void remove(c)}
                          />
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardBody>
      </Card>
      <NewCashierDialog
        open={adding}
        onClose={() => setAdding(false)}
        onDone={(name) => {
          setAdding(false);
          toast.success(`${name} can sign in now, and changes the password at first sign-in.`);
          refresh();
        }}
      />
    </div>
  );
}

const EMPTY = { fullName: '', username: '', password: '', pin: '' };

function NewCashierDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      await api.post('/api/cashiers', { ...form, pin: form.pin.trim() || null });
      onDone(form.fullName);
      setForm(EMPTY);
    } catch (err) {
      const field = err instanceof ApiError && err.field ? err.field : 'form';
      setErrors({ [field]: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title="New cashier"
      description="They sign in with this username and change the password the first time."
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Full name" error={errors.fullName}>
          <Input autoFocus value={form.fullName} onChange={set('fullName')} />
        </Field>
        <Field label="Username" hint="Letters, digits and . _ - only." error={errors.username}>
          <Input value={form.username} onChange={set('username')} autoComplete="off" />
        </Field>
        <Field label="Password" hint="At least 8 characters." error={errors.password}>
          <Input
            type="password"
            value={form.password}
            onChange={set('password')}
            autoComplete="new-password"
          />
        </Field>
        <Field label="PIN (optional)" hint="4 to 6 digits, unique per user." error={errors.pin}>
          <Input type="password" inputMode="numeric" value={form.pin} onChange={set('pin')} />
        </Field>
        {errors.form ? <p className="text-sm text-danger">{errors.form}</p> : null}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add cashier'}
        </Button>
      </form>
    </Dialog>
  );
}
