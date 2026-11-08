import { formatDateTime } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { startFresh } from '@/auth/session';

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
  // Same answer the app asked for at start (cached): is this the online panel?
  const setup = useQuery({
    queryKey: ['setup-status'],
    queryFn: () =>
      api.get<{
        mode: 'shop' | 'cloud';
        waitingForShop?: boolean;
        shops?: { id: string; name: string; lastSeenAt: string | null }[];
        currentShop?: string | null;
        waitingForOwner?: boolean;
        link?: LinkStatus | null;
      }>('/api/setup/status'),
    staleTime: Infinity,
    // A shop linked at setup waits for the owner's account to arrive with a sync.
    refetchInterval: (q) => (q.state.data?.waitingForOwner ? 3_000 : false),
  });
  // Nobody can sign in until the owner's account has arrived: the boxes stay locked till then.
  const waiting = Boolean(setup.data?.waitingForOwner);
  const usernameRef = useRef<HTMLInputElement>(null);
  const wasWaiting = useRef(waiting);
  useLayoutEffect(() => {
    if (wasWaiting.current && !waiting) usernameRef.current?.focus();
    wasWaiting.current = waiting;
  }, [waiting]);
  const cloud = setup.data?.mode === 'cloud';
  // Online panel: users and passwords are each shop's own, so the shop comes first.
  const shops = setup.data?.shops ?? [];
  const [chosen, setChosen] = useState('');
  const shopId = chosen || setup.data?.currentShop || shops[0]?.id || '';
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
      await api.post('/api/auth/login', { username, password, ...(cloud ? { shopId } : {}) });
      // Nothing from whoever used this screen before stays: the app starts again on the menu.
      return startFresh();
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
        {waiting ? <WaitingForOwner link={setup.data?.link ?? null} /> : null}
        {cloud ? (
          <p className="rounded-[8px] bg-surface-2 px-3 py-2 text-sm text-muted">
            {setup.data?.waitingForShop
              ? 'The online panel is waiting for the shop’s first sync. Link the shop in its Settings → Cloud mirror, then sign in here with your shop username and password.'
              : 'The online panel: see each shop as of its last sync. The Super Admin signs in once and sees every shop; others sign in with their username and password at that shop.'}
          </p>
        ) : null}
        {cloud && shops.length ? (
          <Field label="Shop" htmlFor="shop">
            <Select id="shop" value={shopId} onChange={(e) => setChosen(e.target.value)}>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {/* Two shops with one name are told apart by when each last synced. */}
                  {shops.filter((o) => o.name === s.name).length > 1
                    ? `${s.name} (last seen ${s.lastSeenAt ? formatDateTime(s.lastSeenAt) : 'never'})`
                    : s.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="Username" htmlFor="username">
          <Input
            id="username"
            ref={usernameRef}
            autoFocus
            disabled={waiting}
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            disabled={waiting}
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
        <Button
          type="submit"
          variant="primary"
          disabled={waiting || busy || !username || !password}
        >
          {waiting ? "Waiting for the owner's account…" : 'Log in'}
        </Button>
        {/* A recovery code resets the password at the shop, where it counts. */}
        {!cloud && !waiting ? (
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

interface LinkStatus {
  host: string;
  online: boolean;
  lastTryAt: string | null;
  lastError: string;
}

/**
 * A shop linked at setup, before the owner's account has arrived: how the link is doing, and a
 * way to fix a wrong panel address or shop key without setting the shop up again.
 */
function WaitingForOwner({ link }: { link: LinkStatus | null }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState('');
  const [shopKey, setShopKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/api/setup/cloud', { url, shopKey });
      setEditing(false);
      setShopKey('');
      await qc.invalidateQueries({ queryKey: ['setup-status'] });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const where = link?.host ? ` at ${link.host}` : '';
  return (
    <div className="flex flex-col gap-2">
      <div role="status" className="rounded-[8px] bg-surface-2 px-3 py-2 text-sm">
        {link?.lastError ? (
          <span className="text-danger">
            Can&apos;t reach the online panel{where}: {link.lastError}
          </span>
        ) : link?.online ? (
          <span className="text-muted">
            Connected to the online panel{where}. The owner&apos;s account is on its way; you can
            sign in as soon as it arrives.
          </span>
        ) : (
          <span className="text-muted">
            Connecting to the online panel{where}… The owner&apos;s account arrives with the first
            sync (about a minute, with the internet on).
          </span>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2 rounded-[8px] border border-border p-3">
          <Field label="Online panel address" htmlFor="link-url">
            <Input
              id="link-url"
              inputMode="url"
              placeholder="https://arunapaint.vercel.app"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <Field label="Shop key" htmlFor="link-key" hint="The same key every shop uses.">
            <Input
              id="link-key"
              type="password"
              value={shopKey}
              onChange={(e) => setShopKey(e.target.value)}
            />
          </Field>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button
              type="button"
              variant="primary"
              disabled={busy || !url || !shopKey}
              onClick={() => void save()}
            >
              Save and connect
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className="text-left text-sm text-muted underline-offset-2 hover:underline"
          onClick={() => setEditing(true)}
        >
          Change the online panel link
        </button>
      )}
    </div>
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
