import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { useReasons } from '@/components/values';
import { api, errorMessage } from '@/lib/api';

/** V: void, same day only, with a reason and an Admin PIN. The bill stays visible stamped VOID. */
export function VoidDialog({
  sale,
  onClose,
  onDone,
}: {
  sale: { id: string; no: string } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const { can } = useAuth();
  const reasons = useReasons('VOID');
  const [reasonId, setReasonId] = useState('');
  const [note, setNote] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const self = can('bill_history.approve');
  const firstReason = reasons[0]?.id ?? '';
  useEffect(() => {
    setReasonId(firstReason);
    setNote('');
    setPin('');
    setError('');
  }, [sale, firstReason]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post(`/api/sales/${sale!.id}/void`, {
        reasonId,
        note,
        approval: self ? undefined : { pin },
      });
      toast.success(`${sale!.no} is void. Its stock is back.`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open={Boolean(sale)}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={`Void ${sale?.no ?? ''}`}
      description="Same day only. The bill stays visible, stamped VOID."
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Reason">
          <Select autoFocus value={reasonId} onChange={(e) => setReasonId(e.target.value)}>
            {reasons.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {!self ? (
          <Field label="Admin PIN">
            <Input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!reasonId || (!self && pin.length < 4)}>
            Void bill
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
