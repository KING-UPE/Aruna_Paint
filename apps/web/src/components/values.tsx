import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/auth/AuthProvider';
import { api, errorMessage } from '@/lib/api';
import { arrowNav } from '@/lib/arrowNav';
import type { ValueItem } from '@/lib/types';
import { Button } from './ui/button';
import { Combobox } from './ui/combobox';
import { Dialog } from './ui/dialog';
import { Field } from './ui/field';
import { Checkbox, Input } from './ui/input';

export type ValueListName =
  | 'categories'
  | 'brands'
  | 'units'
  | 'locations'
  | 'reasons'
  | 'cutoff-types';

export function useValues(list: ValueListName, includeInactive = false) {
  return useQuery({
    queryKey: ['values', list, includeInactive],
    queryFn: () =>
      api.get<{ items: ValueItem[] }>(
        `/api/values/${list}${includeInactive ? '?includeInactive=1' : ''}`,
      ),
    staleTime: 60_000,
  });
}

/** Reasons that apply to a use (RETURN, VOID, ADJUSTMENT, CASH_IN, CASH_OUT). */
export function useReasons(use: string): ValueItem[] {
  const q = useValues('reasons');
  return (q.data?.items ?? []).filter((r) => r.appliesTo?.includes(use));
}

const NOUN: Record<ValueListName, string> = {
  categories: 'category',
  brands: 'brand',
  units: 'unit',
  locations: 'location',
  reasons: 'reason',
  'cutoff-types': 'cut-off type',
};

/**
 * One picker for every value list, so the same value is never typed two different ways.
 * Typing suggests; a new name offers "+ Add" right there (a small pop-up), if the role allows it.
 */
export function ValueSelect({
  list,
  value,
  onChange,
  allowEmpty = true,
  id,
  invalid,
  autoFocus,
}: {
  list: ValueListName;
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  allowEmpty?: boolean;
  id?: string;
  invalid?: boolean;
  autoFocus?: boolean;
}) {
  const { can } = useAuth();
  const q = useValues(list);
  const [adding, setAdding] = useState<string | null>(null);
  const canAdd = can('values.create') && list !== 'locations';
  const items = (q.data?.items ?? []).filter((v) => v.active || v.id === value);
  const picked = items.find((v) => v.id === value) ?? null;

  return (
    <>
      <Combobox<ValueItem>
        id={id}
        autoFocus={autoFocus}
        invalid={invalid}
        value={picked}
        onChange={(v) => onChange(v?.id ?? null)}
        options={items}
        display={(v) => v.name}
        itemKey={(v) => v.id}
        clearable={allowEmpty}
        placeholder={allowEmpty ? 'None' : 'Type to search'}
        addWhat={NOUN[list]}
        inputProps={{ 'aria-label': NOUN[list][0]!.toUpperCase() + NOUN[list].slice(1) }}
        onAdd={canAdd ? (name) => setAdding(name) : undefined}
      />
      <AddValueDialog
        list={list}
        name={adding}
        onClose={() => setAdding(null)}
        onAdded={(row) => {
          setAdding(null);
          onChange(row.id);
        }}
      />
    </>
  );
}

/** The quick "add a value" pop-up, opened from any picker; the name comes from what was typed. */
export function AddValueDialog({
  list,
  name,
  onClose,
  onAdded,
}: {
  list: ValueListName;
  /** null = closed. */
  name: string | null;
  onClose: () => void;
  onAdded: (row: ValueItem) => void;
}) {
  const qc = useQueryClient();
  const [f, setF] = useState({ name: '', allowsDecimal: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (name === null) return;
    setF({ name, allowsDecimal: false });
    setError('');
  }, [name]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    // The pop-up often opens from inside another form (the product form): don't submit that too.
    e.stopPropagation();
    if (!f.name.trim()) return setError('Type the name.');
    setBusy(true);
    try {
      const row = await api.post<ValueItem>(`/api/values/${list}`, {
        name: f.name.trim(),
        ...(list === 'units' ? { allowsDecimal: f.allowsDecimal } : {}),
      });
      await qc.invalidateQueries({ queryKey: ['values', list] });
      toast.success(`${row.name} added.`);
      onAdded(row);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={name !== null}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={`Add ${NOUN[list]}`}
      description="It is added to the list for everyone, the same as in Value manager."
      className="max-w-md"
    >
      <form onSubmit={save} className="flex flex-col gap-4">
        <Field label="Name" error={error || undefined}>
          <Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        {list === 'units' ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={f.allowsDecimal}
              onChange={(e) => setF({ ...f, allowsDecimal: e.target.checked })}
            />
            Can be sold in parts (like 1.5)
          </label>
        ) : null}
        <div className="flex justify-end gap-2" onKeyDown={arrowNav}>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" icon={<Plus size={16} />} disabled={busy}>
            Add
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
