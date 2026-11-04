import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { api, ApiError, errorMessage } from '@/lib/api';
import { AuthShell } from './LoginPage';

/**
 * First-run wizard: shop details, then the link to the online panel (the owner, the one top Super
 * Admin, arrives from there, so no account is made here) or, for a shop without the online panel,
 * its own Super Admin; then the recovery codes.
 */
export function SetupPage() {
  const qc = useQueryClient();
  const [linked, setLinked] = useState(true);
  const [form, setForm] = useState({
    url: '',
    shopKey: '',
    shopName: 'Pannala Aruna Paint Center',
    address: '',
    phone: '',
    username: '',
    fullName: '',
    password: '',
    pin: '',
  });
  const [codes, setCodes] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setError('');
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/setup', {
        shop: { shopName: form.shopName, address: form.address, phone: form.phone },
        ...(linked
          ? { cloud: { url: form.url, shopKey: form.shopKey } }
          : {
              admin: {
                username: form.username,
                fullName: form.fullName,
                password: form.password,
                pin: form.pin,
              },
            }),
      });
      setCodes(r.recoveryCodes);
    } catch (err) {
      if (err instanceof ApiError && err.field)
        setErrors({ [err.field.split('.').pop()!]: err.message });
      else setError(errorMessage(err));
    }
  };

  if (codes) {
    return (
      <AuthShell
        title="Print the recovery codes"
        subtitle="Keep them somewhere safe. Each one resets a forgotten Super Admin password once."
      >
        <ol className="grid grid-cols-2 gap-2 font-mono text-sm">
          {codes.map((c) => (
            <li key={c} className="rounded border border-border px-2 py-1">
              {c}
            </li>
          ))}
        </ol>
        <div className="flex gap-2">
          <Button onClick={() => window.print()}>Print</Button>
          <Button variant="primary" autoFocus onClick={() => void qc.invalidateQueries()}>
            I have printed them
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Set up the shop" subtitle="This runs once, on the shop server.">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Shop name" error={errors.shopName}>
          <Input autoFocus value={form.shopName} onChange={set('shopName')} />
        </Field>
        <Field label="Address">
          <Input value={form.address} onChange={set('address')} />
        </Field>
        <Field label="Phone">
          <Input value={form.phone} onChange={set('phone')} />
        </Field>
        <hr className="border-border" />
        <Field label="Accounts">
          <Select
            value={linked ? 'cloud' : 'local'}
            onChange={(e) => setLinked(e.target.value === 'cloud')}
          >
            <option value="cloud">From the online panel: the owner signs in</option>
            <option value="local">This shop only: make a Super Admin here</option>
          </Select>
        </Field>
        {linked ? (
          <>
            <Field
              label="Online panel address"
              error={errors.url}
              hint="The owner's account (the top Super Admin) comes from here with the first sync."
            >
              <Input
                value={form.url}
                onChange={set('url')}
                placeholder="https://arunapaint.vercel.app"
                inputMode="url"
              />
            </Field>
            <Field label="Shop key" error={errors.shopKey} hint="The same key every shop uses.">
              <Input type="password" value={form.shopKey} onChange={set('shopKey')} />
            </Field>
          </>
        ) : (
          <>
            <Field label="Super Admin username" error={errors.username}>
              <Input value={form.username} onChange={set('username')} autoComplete="username" />
            </Field>
            <Field label="Full name" error={errors.fullName}>
              <Input value={form.fullName} onChange={set('fullName')} />
            </Field>
            <Field label="Password" error={errors.password} hint="At least 8 characters.">
              <Input
                type="password"
                value={form.password}
                onChange={set('password')}
                autoComplete="new-password"
              />
            </Field>
            <Field
              label="PIN"
              error={errors.pin}
              hint="4 to 6 digits, for switching user and approvals."
            >
              <Input inputMode="numeric" value={form.pin} onChange={set('pin')} />
            </Field>
          </>
        )}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <Button type="submit" variant="primary">
          Set up
        </Button>
      </form>
    </AuthShell>
  );
}
