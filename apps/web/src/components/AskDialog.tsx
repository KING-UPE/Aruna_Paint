import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import { Field } from './ui/field';
import { Input } from './ui/input';

export interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  /** Red button for deletes and other things that can't be undone. */
  danger?: boolean;
}

export interface AskOptions {
  title: string;
  message?: ReactNode;
  label: string;
  hint?: string;
  confirmLabel?: string;
  type?: 'text' | 'password';
  inputMode?: 'text' | 'numeric';
  /** Plain-words reason the value can't be used yet, or null when it is fine. */
  check?: (value: string) => string | null;
}

interface Api {
  confirm: (o: ConfirmOptions) => Promise<boolean>;
  ask: (o: AskOptions) => Promise<string | null>;
}

type State = { kind: 'confirm'; o: ConfirmOptions } | { kind: 'ask'; o: AskOptions } | null;

const AskContext = createContext<Api | null>(null);

/** Yes/no questions and one-line answers in the app's own dialog, instead of the browser's. */
export function AskProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const resolver = useRef<((v: unknown) => void) | null>(null);

  const open = useCallback((s: NonNullable<State>) => {
    setValue('');
    setError('');
    setState(s);
    return new Promise<unknown>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const api = useRef<Api>({
    confirm: (o) => open({ kind: 'confirm', o }) as Promise<boolean>,
    ask: (o) => open({ kind: 'ask', o }) as Promise<string | null>,
  });

  const close = (v: unknown) => {
    resolver.current?.(v);
    resolver.current = null;
    setState(null);
  };
  const cancel = () => close(state?.kind === 'confirm' ? false : null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!state) return;
    if (state.kind === 'confirm') return close(true);
    const v = value.trim();
    const problem = v ? (state.o.check?.(v) ?? null) : 'Type something first.';
    if (problem) return setError(problem);
    close(v);
  };

  const o = state?.o;
  return (
    <AskContext.Provider value={api.current}>
      {children}
      <Dialog
        open={state !== null}
        onOpenChange={(v) => (!v ? cancel() : undefined)}
        title={o?.title ?? ''}
        className="max-w-md"
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          {o?.message ? <div className="text-[15px] text-muted">{o.message}</div> : null}
          {state?.kind === 'ask' ? (
            <Field label={state.o.label} hint={state.o.hint} error={error || undefined}>
              <Input
                autoFocus
                type={state.o.type ?? 'text'}
                inputMode={state.o.inputMode}
                value={value}
                onChange={(e) =>
                  setValue(
                    state.o.inputMode === 'numeric'
                      ? e.target.value.replace(/\D/g, '')
                      : e.target.value,
                  )
                }
              />
            </Field>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
            <Button
              type="submit"
              autoFocus={state?.kind === 'confirm'}
              variant={state?.kind === 'confirm' && state.o.danger ? 'danger' : 'primary'}
            >
              {o?.confirmLabel ?? 'OK'}
            </Button>
          </div>
        </form>
      </Dialog>
    </AskContext.Provider>
  );
}

export function useConfirm() {
  const v = useContext(AskContext);
  if (!v) throw new Error('useConfirm outside AskProvider');
  return v.confirm;
}

export function useAsk() {
  const v = useContext(AskContext);
  if (!v) throw new Error('useAsk outside AskProvider');
  return v.ask;
}
