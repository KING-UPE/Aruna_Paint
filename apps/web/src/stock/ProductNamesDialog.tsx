import { formatQty } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { useConfirm } from '@/components/AskDialog';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/misc';
import { api, ApiError, errorMessage } from '@/lib/api';
import type { ProductDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

interface SubRow {
  id: string;
  code: string;
  name: string;
  /** The code as loaded, to follow a new main code while untouched. */
  loadedCode: string;
  touched: boolean;
  supplier: string;
  stock: string;
  hidden: boolean;
}

/** "10001-02" with the main code swapped: "30001-02". Codes typed by hand are left alone. */
function followCode(sub: SubRow, oldMain: string, newMain: string): string {
  if (sub.touched || !newMain) return sub.code;
  if (sub.loadedCode === oldMain) return newMain;
  return sub.loadedCode.startsWith(`${oldMain}-`)
    ? `${newMain}${sub.loadedCode.slice(oldMain.length)}`
    : sub.code;
}

/**
 * The quick editor from the products list: the product's code and name, and every
 * sub-product's code and name. Old bills follow the new names; the Super Admin sees each change
 * on the product page.
 */
export function ProductNamesDialog({
  productId,
  onClose,
}: {
  productId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({
    queryKey: ['product', productId],
    queryFn: () => api.get<ProductDetail>(`/api/products/${productId}`),
    enabled: Boolean(productId),
  });
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const loadedMain = q.data?.product.code ?? '';
  const ids = useId();

  useEffect(() => {
    if (!q.data || !productId) return;
    setCode(q.data.product.code);
    setName(q.data.product.name);
    setErrors({});
    setSubs(
      q.data.subProducts.map((s) => ({
        id: s.id,
        code: s.code,
        name: s.name,
        loadedCode: s.code,
        touched: false,
        supplier: s.supplier?.name ?? '—',
        stock: s.totalStock,
        hidden: s.hidden,
      })),
    );
  }, [q.data, productId]);

  const onMainCode = (v: string) => {
    setCode(v);
    setSubs((rows) => rows.map((r) => ({ ...r, code: followCode(r, loadedMain, v.trim()) })));
  };

  const save = async (confirmCodeChange = false): Promise<void> => {
    if (!q.data) return;
    setBusy(true);
    setErrors({});
    try {
      await api.patch(`/api/products/${productId}/names`, {
        code,
        name,
        confirmCodeChange,
        subProducts: subs.map((s) => ({ id: s.id, code: s.code, name: s.name })),
      });
      toast.success(`${code} · ${name} saved. Old bills show the new names.`);
      await qc.invalidateQueries({ queryKey: ['products'] });
      await qc.invalidateQueries({ queryKey: ['product', productId] });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.details?.confirm === 'confirmCodeChange') {
        setBusy(false);
        const ok = await confirm({
          title: `Change ${loadedMain} to ${code}?`,
          message: err.message,
          confirmLabel: 'Change the code',
        });
        if (ok) return save(true);
        return;
      }
      if (err instanceof ApiError && err.field) {
        setErrors({ [err.field]: err.message });
      } else {
        toast.error(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save();
  };

  const setSub = (id: string, patch: Partial<SubRow>) =>
    setSubs((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <Dialog
      open={Boolean(productId)}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={q.data ? `Edit ${q.data.product.code} · ${q.data.product.name}` : 'Edit product'}
      description="Code and name of the product and its sub-products. Old bills show the new names."
      className="max-w-3xl"
    >
      {!q.data ? (
        <div className="grid place-items-center py-10">
          <Spinner />
        </div>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-5">
          <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)]">
            <Field label="Code" error={errors.code} htmlFor={`${ids}-code`}>
              <Input
                id={`${ids}-code`}
                autoFocus
                value={code}
                onChange={(e) => onMainCode(e.target.value)}
                aria-invalid={Boolean(errors.code)}
                className="font-mono"
              />
            </Field>
            <Field label="Name" error={errors.name} htmlFor={`${ids}-name`}>
              <Input
                id={`${ids}-name`}
                value={name}
                onChange={(e) => {
                  const v = e.target.value;
                  // Sub-products that carried the old name follow the new one.
                  setSubs((rows) =>
                    rows.map((r) => (r.name === name && !r.touched ? { ...r, name: v } : r)),
                  );
                  setName(v);
                }}
                aria-invalid={Boolean(errors.name)}
              />
            </Field>
          </div>

          <section className="flex flex-col gap-2">
            <div className="flex items-end justify-between">
              <h3 className="text-sm font-semibold">
                Sub-products <span className="font-normal text-muted">({subs.length})</span>
              </h3>
              <span className="text-xs text-muted">
                Codes follow a new main code unless you change them here.
              </span>
            </div>
            {subs.length === 0 ? (
              <p className="rounded-[12px] border border-dashed border-border py-6 text-center text-sm text-muted">
                No sub-products yet. They are made when stock is first received.
              </p>
            ) : (
              <div className="overflow-hidden rounded-[12px] border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-left text-muted">
                    <tr>
                      <th className="w-44 px-3 py-2 font-medium">Code</th>
                      <th className="px-3 py-2 font-medium">Name</th>
                      <th className="hidden px-3 py-2 font-medium md:table-cell">Supplier</th>
                      <th className="px-3 py-2 text-right font-medium">Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subs.map((s, i) => {
                      const codeErr = errors[`subProducts.${i}.code`];
                      const nameErr = errors[`subProducts.${i}.name`];
                      return (
                        <tr
                          key={s.id}
                          className={cn(
                            'border-t border-border align-top',
                            s.hidden && 'text-muted',
                          )}
                        >
                          <td className="px-3 py-2">
                            <Input
                              aria-label={`Code of sub-product ${i + 1}`}
                              value={s.code}
                              onChange={(e) =>
                                setSub(s.id, { code: e.target.value, touched: true })
                              }
                              aria-invalid={Boolean(codeErr)}
                              className="h-9 font-mono text-sm"
                            />
                            {codeErr ? <p className="mt-1 text-xs text-danger">{codeErr}</p> : null}
                          </td>
                          <td className="px-3 py-2">
                            <Input
                              aria-label={`Name of sub-product ${i + 1}`}
                              value={s.name}
                              onChange={(e) =>
                                setSub(s.id, { name: e.target.value, touched: true })
                              }
                              aria-invalid={Boolean(nameErr)}
                              className="h-9 text-sm"
                            />
                            {nameErr ? <p className="mt-1 text-xs text-danger">{nameErr}</p> : null}
                          </td>
                          <td className="hidden px-3 py-2 pt-4 md:table-cell">{s.supplier}</td>
                          <td className="num px-3 py-2 pt-4">{formatQty(s.stock)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={busy}>
              Save
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
