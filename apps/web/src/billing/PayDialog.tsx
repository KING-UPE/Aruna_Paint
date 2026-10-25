import { D, computeChange, formatMoney } from '@aruna/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

type Stage = 'cash' | 'print';

/**
 * F10: type the cash given (empty means exact) and Enter shows the change in large type.
 * "Print receipt?" then asks Yes or No with Yes selected; the drawer opens either way.
 */
export function PayDialog({
  open,
  kind,
  netTotal,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  kind: 'INVOICE' | 'QUOTATION';
  netTotal: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: (cashGiven: string | null, print: boolean) => void;
}) {
  const [stage, setStage] = useState<Stage>(kind === 'INVOICE' ? 'cash' : 'print');
  const [cash, setCash] = useState('');
  const [cashError, setCashError] = useState('');
  const [change, setChange] = useState<string | null>(null);
  const cashRef = useRef<HTMLInputElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) {
      setStage(kind === 'INVOICE' ? 'cash' : 'print');
      setCash('');
      setCashError('');
      setChange(null);
    }
  }, [open, kind]);

  // Yes takes the keyboard as soon as the change shows, so Enter prints.
  useLayoutEffect(() => {
    if (open && stage === 'print') yesRef.current?.focus();
  }, [open, stage]);

  const toPrint = () => {
    try {
      const c = computeChange(netTotal, cash.replace(/,/g, '') || null);
      setChange(c.change.toFixed(2));
      setCashError('');
      setStage('print');
    } catch (err) {
      setCashError(err instanceof Error ? err.message : 'Check the cash given.');
    }
  };

  const cashGiven = cash.trim() ? D(cash.replace(/,/g, '')).toFixed(2) : null;
  const label = kind === 'QUOTATION' ? 'Print quotation?' : 'Print receipt?';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={kind === 'QUOTATION' ? 'Issue quotation' : 'Cash payment'}
      initialFocus={() => (stage === 'cash' ? cashRef.current : yesRef.current)}
    >
      <div className="flex flex-col gap-4">
        <div className="flex items-baseline justify-between">
          <span className="text-muted">Net total</span>
          <span className="num text-3xl font-bold">Rs {formatMoney(netTotal)}</span>
        </div>
        {kind === 'INVOICE' ? (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="cash-given" className="text-sm font-medium">
              Cash given <span className="font-normal text-muted">(empty = exact cash)</span>
            </label>
            <Input
              id="cash-given"
              ref={cashRef}
              inputMode="decimal"
              autoComplete="off"
              value={cash}
              disabled={stage === 'print'}
              onChange={(e) => setCash(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  toPrint();
                }
              }}
              className="num h-14 text-2xl"
            />
            {cashError ? (
              <p role="alert" className="text-sm text-danger">
                {cashError}
              </p>
            ) : null}
          </div>
        ) : null}
        {change !== null ? (
          <div className="flex items-baseline justify-between rounded-[var(--radius-card)] bg-ok-soft px-4 py-3">
            <span className="font-medium text-ok">Change</span>
            <span className="num text-4xl font-bold text-ok">Rs {formatMoney(change)}</span>
          </div>
        ) : null}
        {stage === 'print' ? (
          <div
            className="flex items-center justify-between gap-3"
            onKeyDown={(e) => {
              if (e.key.toLowerCase() === 'n') {
                e.preventDefault();
                onConfirm(cashGiven, false);
              } else if (e.key.toLowerCase() === 'y') {
                e.preventDefault();
                onConfirm(cashGiven, true);
              } else if (e.key === 'Escape' && kind === 'INVOICE') {
                e.preventDefault();
                e.stopPropagation();
                setStage('cash');
                window.setTimeout(() => cashRef.current?.focus(), 0);
              }
            }}
          >
            <span className="text-lg font-semibold">{label}</span>
            <div className="flex gap-2">
              <Button
                ref={yesRef}
                variant="primary"
                size="lg"
                disabled={busy}
                onClick={() => onConfirm(cashGiven, true)}
              >
                Yes
              </Button>
              <Button size="lg" disabled={busy} onClick={() => onConfirm(cashGiven, false)}>
                No
              </Button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm font-medium text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
