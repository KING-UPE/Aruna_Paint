import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, ApiError, errorMessage } from '@/lib/api';
import { AuthShell } from './LoginPage';

/** A reset password must be changed at next login. */
export function ChangePasswordPage({
  forced = true,
  onDone,
}: {
  forced?: boolean;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setError('');
    if (newPassword !== repeat) {
      setErrors({ repeat: 'The two passwords are different.' });
      return;
    }
    try {
      await api.post('/api/auth/change-password', { currentPassword, newPassword });
      await qc.invalidateQueries({ queryKey: ['me'] });
      onDone?.();
    } catch (err) {
      if (err instanceof ApiError && err.field) setErrors({ [err.field]: err.message });
      else setError(errorMessage(err));
    }
  };

  return (
    <AuthShell
      title="Change your password"
      subtitle={forced ? 'Your password was reset. Choose a new one to continue.' : undefined}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Current password" error={errors.currentPassword}>
          <Input
            autoFocus
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="New password" error={errors.newPassword} hint="At least 8 characters.">
          <Input type="password" value={newPassword} onChange={(e) => setNew(e.target.value)} />
        </Field>
        <Field label="New password again" error={errors.repeat}>
          <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
        </Field>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <Button type="submit" variant="primary">
          Change password
        </Button>
        {forced ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              void api.post('/api/auth/logout', {}).finally(() => qc.setQueryData(['me'], null))
            }
          >
            Log out
          </Button>
        ) : null}
      </form>
    </AuthShell>
  );
}
