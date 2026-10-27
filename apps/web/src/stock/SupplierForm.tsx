import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { useConfirm } from '@/components/AskDialog';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { Supplier } from '@/lib/types';

interface Form {
  code: string;
  name: string;
  phones: string[];
  address: string;
  description: string;
  email: string;
  creditDays: string;
  openingBalance: string;
  active: boolean;
  reps: { id?: string; name: string; phone: string; active: boolean }[];
}

const blank: Form = {
  code: '',
  name: '',
  phones: [''],
  address: '',
  description: '',
  email: '',
  creditDays: '0',
  openingBalance: '0',
  active: true,
  reps: [],
};

/** Code (auto), name, 1–3 phone numbers, address, email, credit days, opening balance, sales reps. */
export function SupplierForm({
  open,
  supplier,
  onClose,
  onSaved,
  initialName,
  onUseSimilar,
}: {
  open: boolean;
  supplier?: Supplier;
  onClose: () => void;
  onSaved?: (s: Supplier) => void;
  /** A new supplier's name, typed in a picker before "+ Add supplier". */
  initialName?: string;
  /** Opened from a picker: the similar-name warning offers to use that supplier instead. */
  onUseSimilar?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const nav = useNavigate();
  const [f, setF] = useState<Form>(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [warning, setWarning] = useState<{
    message: string;
    similar?: { id: string; code: string; name: string; active?: boolean };
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setWarning(null);
    setF(
      supplier
        ? {
            code: supplier.code,
            name: supplier.name,
            phones: supplier.phones.length ? supplier.phones : [''],
            address: supplier.address,
            description: supplier.description,
            email: supplier.email,
            creditDays: String(supplier.creditDays),
            openingBalance: supplier.openingBalance,
            active: supplier.active,
            reps: supplier.reps,
          }
        : { ...blank, name: initialName ?? '' },
    );
  }, [open, supplier, initialName]);

  const save = async (confirmSimilarName = false) => {
    setErrors({});
    try {
      const body = {
        code: f.code || null,
        name: f.name,
        phones: f.phones.filter((p) => p.trim()),
        address: f.address,
        description: f.description,
        email: f.email,
        creditDays: Number(f.creditDays || 0),
        openingBalance: f.openingBalance || '0',
        active: f.active,
        reps: f.reps.filter((r) => r.name.trim()),
        confirmSimilarName,
      };
      const s = supplier
        ? await api.put<Supplier>(`/api/suppliers/${supplier.id}`, body)
        : await api.post<Supplier>('/api/suppliers', body);
      toast.success(`${s.code} · ${s.name} saved.`);
      await qc.invalidateQueries({ queryKey: ['suppliers'] });
      onSaved?.(s);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.isWarning) {
        setWarning({
          message: err.message,
          similar: err.details?.similar as
            | { id: string; code: string; name: string; active?: boolean }
            | undefined,
        });
      } else if (err instanceof ApiError && err.field)
        setErrors({ [err.field.split('.')[0]!]: err.message });
      else toast.error(errorMessage(err));
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void save();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={supplier ? `Edit ${supplier.code}` : 'New supplier'}
      className="max-w-2xl"
    >
      <form onSubmit={submit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field
          label="Code"
          hint={supplier ? undefined : 'Empty gets the next SUP- number.'}
          error={errors.code}
        >
          <Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        </Field>
        <Field label="Name" error={errors.name}>
          <Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Phone numbers (1 to 3)" error={errors.phones} className="sm:col-span-2">
          <div className="flex gap-2">
            {f.phones.map((p, i) => (
              <Input
                key={i}
                value={p}
                placeholder="0771234567"
                onChange={(e) =>
                  setF({ ...f, phones: f.phones.map((x, j) => (j === i ? e.target.value : x)) })
                }
              />
            ))}
            {f.phones.length < 3 ? (
              <Button
                type="button"
                size="sm"
                className="h-10"
                icon={<Plus size={15} />}
                onClick={() => setF({ ...f, phones: [...f.phones, ''] })}
              >
                Phone
              </Button>
            ) : null}
          </div>
        </Field>
        <Field label="Address" className="sm:col-span-2">
          <Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </Field>
        <Field label="Email" error={errors.email}>
          <Input
            type="email"
            value={f.email}
            onChange={(e) => setF({ ...f, email: e.target.value })}
          />
        </Field>
        <Field label="Credit days">
          <Input
            inputMode="numeric"
            className="num"
            value={f.creditDays}
            onChange={(e) => setF({ ...f, creditDays: e.target.value.replace(/\D/g, '') })}
          />
        </Field>
        <Field
          label="Opening balance (Rs)"
          hint="Positive means the shop owes the supplier."
          error={errors.openingBalance}
        >
          <Input
            className="num"
            value={f.openingBalance}
            onChange={(e) => setF({ ...f, openingBalance: e.target.value })}
          />
        </Field>
        <label className="flex items-end gap-2 pb-2 text-sm">
          <Checkbox checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{' '}
          Active
        </label>
        <Field label="Description" className="sm:col-span-2">
          <Textarea
            rows={2}
            value={f.description}
            onChange={(e) => setF({ ...f, description: e.target.value })}
          />
        </Field>
        <div className="sm:col-span-2">
          <div className="mb-1.5 text-sm font-medium">Sales reps</div>
          {f.reps.map((r, i) => (
            <div key={r.id ?? i} className="mb-2 grid grid-cols-[1fr_1fr_auto] gap-2">
              <Input
                placeholder="Name"
                value={r.name}
                onChange={(e) =>
                  setF({
                    ...f,
                    reps: f.reps.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                  })
                }
              />
              <Input
                placeholder="Phone"
                value={r.phone}
                onChange={(e) =>
                  setF({
                    ...f,
                    reps: f.reps.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)),
                  })
                }
              />
              <label className="flex items-center gap-1 text-sm">
                <Checkbox
                  checked={r.active}
                  onChange={(e) =>
                    setF({
                      ...f,
                      reps: f.reps.map((x, j) =>
                        j === i ? { ...x, active: e.target.checked } : x,
                      ),
                    })
                  }
                />{' '}
                Active
              </label>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            icon={<Plus size={15} />}
            onClick={() => setF({ ...f, reps: [...f.reps, { name: '', phone: '', active: true }] })}
          >
            Sales rep
          </Button>
        </div>
        {warning ? (
          <div className="rounded-[8px] bg-warn-soft p-3 text-sm text-warn sm:col-span-2">
            <div>{warning.message}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="primary" onClick={() => void save(true)}>
                Save anyway
              </Button>
              {warning.similar?.id ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const similar = warning.similar!.id;
                    onClose();
                    if (onUseSimilar) onUseSimilar(similar);
                    else nav(`/stock/suppliers/${similar}`);
                  }}
                >
                  {onUseSimilar ? 'Use' : 'View'} {warning.similar.code} ({warning.similar.name})
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-2 sm:col-span-2">
          <div>
            {supplier ? (
              <Button
                type="button"
                variant="ghost"
                className="text-danger hover:bg-danger/10 hover:text-danger"
                icon={<Trash2 size={16} />}
                onClick={async () => {
                  const ok = await confirm({
                    title: 'Delete supplier?',
                    message: `${supplier.name} (${supplier.code}) will be removed. This can't be undone.`,
                    confirmLabel: 'Delete supplier',
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    await api.delete(`/api/suppliers/${supplier.id}`);
                    toast.success(`Supplier "${supplier.name}" deleted.`);
                    await qc.invalidateQueries({ queryKey: ['suppliers'] });
                    onClose();
                  } catch (err) {
                    toast.error(errorMessage(err));
                  }
                }}
              >
                Delete supplier
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary">
              Save
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
