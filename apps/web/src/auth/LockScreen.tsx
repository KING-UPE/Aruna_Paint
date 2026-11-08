import { useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import type { Me } from '@/lib/types';
import { signOut, startFresh } from '@/auth/session';

/** The idle lock. Any user's PIN unlocks it and switches this PC to that user. */
export function LockScreen({ me }: { me: Me }) {
  const qc = useQueryClient();
  const [pin, setPin] = useState('');
  const [password, setPassword] = useState('');
  // Someone without a PIN unlocks with their password (another person's PIN still switches).
  const [usePassword, setUsePassword] = useState(!me.hasPin);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (usePassword) await api.post('/api/auth/unlock', { password });
      else {
        const r = await api.post<{ switched?: boolean }>('/api/auth/pin', { pin });
        // Another person's PIN: their screens start fresh, not on the previous user's page.
        if (r.switched) return startFresh();
      }
      setPin('');
      await qc.invalidateQueries();
    } catch (err) {
      setError(errorMessage(err));
      setPin('');
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-bg/95 p-4 backdrop-blur">
      <form
        onSubmit={submit}
        className="flex w-full max-w-xs flex-col items-center gap-4 text-center"
      >
        <Lock className="text-muted" size={32} />
        <div>
          <h1 className="text-xl font-semibold">Screen locked</h1>
          <p className="text-sm text-muted">{me.user.fullName}</p>
        </div>
        {usePassword ? (
          <Input
            key="pw"
            autoFocus
            type="password"
            aria-label="Password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        ) : (
          <Input
            key="pin"
            autoFocus
            type="password"
            inputMode="numeric"
            aria-label="PIN"
            placeholder="PIN"
            className="h-14 text-center text-2xl tracking-[0.5em]"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
        )}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : (
          <p className="text-sm text-muted">
            {usePassword
              ? me.hasPin
                ? 'Type your password and press Enter.'
                : 'You have no PIN yet: type your password and press Enter. Set a PIN in My profile.'
              : 'Type a PIN and press Enter to switch user.'}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setUsePassword(!usePassword)}
          >
            {usePassword ? 'Use a PIN' : 'Use my password'}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => void signOut()}>
            Log out
          </Button>
        </div>
      </form>
    </div>
  );
}
