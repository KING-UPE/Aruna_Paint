import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';

/** Start of day: the opening cash float. */
export function StartDayDialog({
  open,
  onDone,
  onClose,
}: {
  open: boolean;
  onDone: () => void;
  onClose: () => void;
}) {
  const [float, setFloat] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/api/shifts/open', { openingFloat: float.trim() || '0' });
      setFloat('');
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title="Start the day"
      description="Count the cash in the drawer before the first bill."
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Opening cash float (Rs)" error={error}>
          <Input
            autoFocus
            inputMode="decimal"
            className="num h-12 text-xl"
            value={float}
            onChange={(e) => setFloat(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary">
          Start the day
        </Button>
      </form>
    </Dialog>
  );
}
