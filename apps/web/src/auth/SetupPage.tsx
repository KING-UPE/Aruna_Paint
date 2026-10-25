import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, ApiError, errorMessage } from '@/lib/api';
import { setCounterCode } from '@/lib/counter';
import { AuthShell } from './LoginPage';

/** First-run wizard: shop details, the Super Admin account and recovery codes, counter C1. */
export function SetupPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    shopName: 'Pannala Aruna Paint Center',
    address: '',
    phone: '',
    username: '',
    fullName: '',
    password: '',
    pin: '',
    counterCode: 'C1',
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
      const r = await api.post<{ recoveryCodes: string[]; counterCode: string }>('/api/setup', {
        shop: { shopName: form.shopName, address: form.address, phone: form.phone },
        admin: {
          username: form.username,
          fullName: form.fullName,
          password: form.password,
          pin: form.pin,
        },
        counterCode: form.counterCode,
      });
      setCounterCode(r.counterCode);
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
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <Button type="submit" variant="primary">
          Set up
        </Button>
      </form>
    </AuthShell>
  );
}
