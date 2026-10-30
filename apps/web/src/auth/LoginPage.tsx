import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';

export function AuthShell({
  children,
  title,
  subtitle,
}: {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
}) {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardBody className="flex flex-col gap-4">
          <div>
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-[10px] bg-accent text-lg font-bold text-accent-text">
              A
            </div>
            <h1 className="text-xl font-semibold">{title}</h1>
            {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
          </div>
          {children}
        </CardBody>
      </Card>
    </div>
  );
}

/** Username and password login. */
export function LoginPage() {
  const qc = useQueryClient();
  // Same answer the app asked for at start (cached): is this the online panel?
  const setup = useQuery({
    queryKey: ['setup-status'],
    queryFn: () =>
      api.get<{ mode: 'shop' | 'cloud'; waitingForShop?: boolean }>('/api/setup/status'),
    staleTime: Infinity,
  });
  const cloud = setup.data?.mode === 'cloud';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recover, setRecover] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/login', { username, password });
      await qc.invalidateQueries();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (recover) return <RecoverPage onDone={() => setRecover(false)} />;

  return (
    <AuthShell
      title={cloud ? 'Aruna POS · Online' : 'Aruna POS'}
      subtitle="Pannala Aruna Paint Center"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        {cloud ? (
          <p className="rounded-[8px] bg-surface-2 px-3 py-2 text-sm text-muted">
            {setup.data?.waitingForShop
              ? 'The online panel is waiting for the shop’s first sync. Link the shop in its Settings → Cloud mirror, then sign in here with your shop username and password.'
              : 'The online panel, for Admins and the Super Admin. Sign in with your shop username and password.'}
          </p>
        ) : null}
        <Field label="Username" htmlFor="username">
          <Input
            id="username"
            autoFocus
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={busy || !username || !password}>
          Log in
        </Button>
        {/* A recovery code resets the password at the shop, where it counts. */}
        {!cloud ? (
          <button
            type="button"
            className="text-left text-sm text-muted underline-offset-2 hover:underline"
            onClick={() => setRecover(true)}
          >
            Forgot the Super Admin password? Use a recovery code
          </button>
        ) : null}
      </form>
    </AuthShell>
  );
}

function RecoverPage({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ username: '', recoveryCode: '', newPassword: '' });
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post<{ recoveryCodesLeft: number }>('/api/auth/recover', form);
      setMsg(`Password changed. ${r.recoveryCodesLeft} recovery codes left.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <AuthShell title="Recover the Super Admin" subtitle="Each printed recovery code works once.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Super Admin username">
          <Input
            autoFocus
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
        </Field>
        <Field label="Recovery code">
          <Input
            value={form.recoveryCode}
            onChange={(e) => setForm({ ...form, recoveryCode: e.target.value })}
            placeholder="XXXX-XXXX-XXXX"
          />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <Input
            type="password"
            value={form.newPassword}
            onChange={(e) => setForm({ ...form, newPassword: e.target.value })}
          />
        </Field>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        {msg ? <p className="text-sm text-ok">{msg}</p> : null}
        <Button type="submit" variant="primary">
          Reset password
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Back to login
        </Button>
      </form>
    </AuthShell>
  );
}
