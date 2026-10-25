import type { ApprovalKind } from '@aruna/shared';
import { APPROVALS } from '@aruna/shared';
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Input } from './ui/input';

type Ask = (kind: ApprovalKind, reason?: string) => Promise<string | null>;

const PinContext = createContext<Ask | null>(null);

/**
 * Manager override: when a cashier hits a limit, an approver types their PIN on the same screen.
 * The PIN is checked straight away and handed back to send with the action.
 */
export function PinPromptProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ kind: ApprovalKind; reason?: string } | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const resolver = useRef<((pin: string | null) => void) | null>(null);

  const ask = useCallback<Ask>((kind, reason) => {
    setPin('');
    setError('');
    setState({ kind, reason });
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (value: string | null) => {
    resolver.current?.(value);
    resolver.current = null;
    setState(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!state) return;
    try {
      await api.post('/api/auth/verify-approval', { kind: state.kind, pin });
      close(pin);
    } catch (err) {
      setError(errorMessage(err));
      setPin('');
    }
  };

  return (
    <PinContext.Provider value={ask}>
      {children}
      <Dialog
        open={state !== null}
        onOpenChange={(o) => (!o ? close(null) : undefined)}
        title={state ? APPROVALS[state.kind].label : ''}
        description={
          state?.reason ?? 'An approver types their PIN here. Both names go into the log.'
        }
      >
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input
            autoFocus
            type="password"
            inputMode="numeric"
            aria-label="Approver PIN"
            placeholder="PIN"
            maxLength={6}
            className="h-12 text-center text-xl tracking-[0.4em]"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          />
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => close(null)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pin.length < 4}>
              Approve
            </Button>
          </div>
        </form>
      </Dialog>
    </PinContext.Provider>
  );
}

export function usePinPrompt(): Ask {
  const v = useContext(PinContext);
  if (!v) throw new Error('usePinPrompt outside PinPromptProvider');
  return v;
}
