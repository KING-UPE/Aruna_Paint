import { AlertTriangle, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';

/** One shop, or every shop on the panel. */
export type RemoveTarget = { id: string; name: string; current: boolean } | { all: number };

/**
 * Taking a shop off the online panel deletes everything the panel holds for it, so the owner
 * types the shop's name (or REMOVE ALL) before the button works.
 */
export function RemoveShopDialog({
  target,
  onClose,
  onRemoved,
}: {
  target: RemoveTarget | null;
  onClose: () => void;
  onRemoved: (removedCurrent: boolean) => void;
}) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const all = target !== null && 'all' in target;
  const words = target === null ? '' : 'all' in target ? 'REMOVE ALL' : target.name;
  const matches = typed.trim().toLowerCase() === words.trim().toLowerCase() && words !== '';

  const close = () => {
    setTyped('');
    setError('');
    onClose();
  };
  const remove = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!target || !matches) return;
    setBusy(true);
    setError('');
    try {
      if ('all' in target) {
        await api.post('/api/cloud/shops/remove-all', { confirm: typed });
        onRemoved(true);
      } else {
        const r = await api.delete<{ removedCurrent: boolean }>(`/api/cloud/shops/${target.id}`);
        onRemoved(r.removedCurrent);
      }
      setTyped('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(o) => (o ? undefined : close())}
      title={
        target === null
          ? ''
          : 'all' in target
            ? `Remove all ${target.all} shops from the online panel?`
            : `Remove ${target.name} from the online panel?`
      }
    >
      <form onSubmit={remove} className="flex flex-col gap-3 text-[15px]">
        <div className="flex gap-3 rounded-md border border-danger bg-danger-soft p-3">
          <AlertTriangle size={20} className="mt-0.5 shrink-0 text-danger" />
          <ul className="flex list-disc flex-col gap-1.5 pl-4">
            <li>
              <strong>
                Everything the online panel holds for {all ? 'every shop' : 'this shop'} is deleted
              </strong>
              : its bills, stock, customers, suppliers, users and reports as last synced. This
              can&apos;t be undone.
            </li>
            <li>
              The shop PC keeps its own data. If Aruna POS is still installed there, it comes back
              here as a shop with all its data at its next sync.
            </li>
            <li>
              To wipe a shop PC too, uninstall Aruna POS on it and choose <strong>Yes</strong> when
              it asks to delete the shop&apos;s data.
            </li>
            {all ? (
              <li>
                Your owner account stays. With no shop left, nobody can sign in here until a shop
                links again.
              </li>
            ) : target && 'current' in target && target.current ? (
              <li>You are looking at this shop: the panel moves to another one afterwards.</li>
            ) : null}
          </ul>
        </div>
        <Field
          label={`Type ${all ? 'REMOVE ALL' : 'the shop name'} to confirm`}
          htmlFor="remove-shop-words"
        >
          <Input
            id="remove-shop-words"
            autoFocus
            autoComplete="off"
            placeholder={words}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </Field>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            icon={<Trash2 size={16} />}
            disabled={!matches || busy}
          >
            {busy ? 'Removing…' : all ? 'Remove all shops' : 'Remove shop'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
