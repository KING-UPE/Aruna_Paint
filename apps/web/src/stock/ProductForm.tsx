import { productInputSchema, type ProductInput } from '@aruna/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Checkbox, Input, Select, Textarea } from '@/components/ui/input';
import { ValueSelect } from '@/components/values';
import { api, ApiError, errorMessage, qs } from '@/lib/api';
import type { Page, ProductDetail, ProductSummary, StockListItem } from '@/lib/types';

type FormIn = z.input<typeof productInputSchema>;
type FormOut = z.output<typeof productInputSchema>;

function toForm(p?: ProductSummary): FormIn {
  return {
    code: p?.code ?? '',
    name: p?.name ?? '',
    printName: p?.printName ?? '',
    description: p?.description ?? '',
    categoryId: p?.category?.id ?? null,
    brandId: p?.brand?.id ?? null,
    unitId: p?.unit.id ?? '',
    packSize: p?.packSize ?? null,
    buyingUnitId: p?.buyingUnit?.id ?? null,
    piecesPerBox: p?.piecesPerBox ?? 1,
    reorderLevel: p?.reorderLevel ?? '0',
    reorderQty: p?.reorderQty ?? '0',
    allowLooseSale: p?.allowLooseSale ?? false,
    mixProductId: p?.mixProduct?.id ?? null,
    trackExpiry: p?.trackExpiry ?? false,
    active: p?.active ?? true,
  };
}

/**
 * Main product fields: code (old code on import, otherwise the next 5 digits), names, category,
 * brand, unit, pack size, boxes, reorder level and qty, loose sale and mix paint link, expiry.
 */
export function ProductForm({
  open,
  product,
  onClose,
  onSaved,
}: {
  open: boolean;
  product?: ProductSummary;
  onClose: () => void;
  onSaved?: (p: ProductDetail) => void;
}) {
  const qc = useQueryClient();
  const form = useForm<FormIn, unknown, FormOut>({
    resolver: zodResolver(productInputSchema),
    defaultValues: toForm(product),
  });
  const [confirm, setConfirm] = useState<string | null>(null);
  const loose = form.watch('allowLooseSale');
  const mixItems = useQuery({
    queryKey: ['products', 'mix-list'],
    queryFn: () =>
      api.get<Page<StockListItem>>(`/api/products${qs({ type: 'MIX', pageSize: 200 })}`),
    enabled: open && loose,
  });

  useEffect(() => {
    if (open) {
      form.reset(toForm(product));
      setConfirm(null);
    }
  }, [open, product, form]);

  const save = async (values: FormOut, confirmCodeChange = false) => {
    try {
      const body: ProductInput = { ...values, code: values.code || null, confirmCodeChange };
      const r = product
        ? await api.put<ProductDetail>(`/api/products/${product.id}`, body)
        : await api.post<ProductDetail & { warnings: string[] }>('/api/products', body);
      for (const w of (r as { warnings?: string[] }).warnings ?? []) toast.warning(w);
      toast.success(`${r.product.code} · ${r.product.name} saved.`);
      await qc.invalidateQueries({ queryKey: ['products'] });
      await qc.invalidateQueries({ queryKey: ['product', r.product.id] });
      onSaved?.(r);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.details?.confirm === 'confirmCodeChange') {
        setConfirm(err.message);
        return;
      }
      if (err instanceof ApiError && err.field)
        form.setError(err.field as keyof FormIn, { message: err.message });
      else toast.error(errorMessage(err));
    }
  };

  const e = form.formState.errors;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={product ? `Edit ${product.code}` : 'New product'}
      className="max-w-2xl"
    >
      <form
        onSubmit={form.handleSubmit((v) => save(v))}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter' && ev.ctrlKey) {
            ev.preventDefault();
            void form.handleSubmit((v) => save(v))();
          }
        }}
        className="grid grid-cols-1 gap-3 sm:grid-cols-2"
      >
        <Field
          label="Code"
          error={e.code?.message}
          hint={product ? undefined : 'Leave empty for the next 5-digit code.'}
        >
          <Input {...form.register('code')} />
        </Field>
        <Field label="Name" error={e.name?.message}>
          <Input autoFocus {...form.register('name')} />
        </Field>
        <Field label="Short name for the receipt" error={e.printName?.message}>
          <Input maxLength={40} {...form.register('printName')} />
        </Field>
        <Field label="Unit" error={e.unitId?.message}>
          <Controller
            control={form.control}
            name="unitId"
            render={({ field }) => (
              <ValueSelect
                list="units"
                value={field.value}
                onChange={(v) => field.onChange(v ?? '')}
                allowEmpty={false}
              />
            )}
          />
        </Field>
        <Field label="Category">
          <Controller
            control={form.control}
            name="categoryId"
            render={({ field }) => (
              <ValueSelect list="categories" value={field.value} onChange={field.onChange} />
            )}
          />
        </Field>
        <Field label="Brand">
          <Controller
            control={form.control}
            name="brandId"
            render={({ field }) => (
              <ValueSelect list="brands" value={field.value} onChange={field.onChange} />
            )}
          />
        </Field>
        <Field label="Buying unit" hint="For items bought in boxes and sold singly.">
          <Controller
            control={form.control}
            name="buyingUnitId"
            render={({ field }) => (
              <ValueSelect list="units" value={field.value} onChange={field.onChange} />
            )}
          />
        </Field>
        <Field label="Pieces per box" error={e.piecesPerBox?.message}>
          <Input
            type="number"
            min={1}
            {...form.register('piecesPerBox', { valueAsNumber: true })}
          />
        </Field>
        <Field label="Reorder level" error={e.reorderLevel?.message}>
          <Input className="num" {...form.register('reorderLevel')} />
        </Field>
        <Field label="Reorder qty" error={e.reorderQty?.message}>
          <Input className="num" {...form.register('reorderQty')} />
        </Field>
        <Field label="Pack size (liters per can)" error={e.packSize?.message}>
          <Controller
            control={form.control}
            name="packSize"
            render={({ field }) => (
              <Input
                className="num"
                value={field.value ?? ''}
                onChange={(ev) => field.onChange(ev.target.value || null)}
              />
            )}
          />
        </Field>
        <div className="flex flex-col justify-end gap-2 pb-1">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox {...form.register('allowLooseSale')} /> Sold loose from mix paint
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox {...form.register('trackExpiry')} /> Track expiry
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox {...form.register('active')} /> Active
          </label>
        </div>
        {loose ? (
          <Field
            label="Mix paint item"
            hint="Leave as new to make MP-<code>; or link this size to an existing one."
            className="sm:col-span-2"
          >
            <Controller
              control={form.control}
              name="mixProductId"
              render={({ field }) => (
                <Select
                  value={field.value ?? ''}
                  onChange={(ev) => field.onChange(ev.target.value || null)}
                >
                  <option value="">
                    {product?.mixProduct ? product.mixProduct.code : 'New mix paint item'}
                  </option>
                  {(mixItems.data?.items ?? []).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.code} · {m.name}
                    </option>
                  ))}
                </Select>
              )}
            />
          </Field>
        ) : null}
        <Field label="Description" className="sm:col-span-2">
          <Textarea rows={2} {...form.register('description')} />
        </Field>
        {confirm ? (
          <div className="rounded-[8px] bg-warn-soft p-3 text-sm text-warn sm:col-span-2">
            {confirm}
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={() => void form.handleSubmit((v) => save(v, true))()}
              >
                Rename the codes
              </Button>
              <Button type="button" size="sm" onClick={() => setConfirm(null)}>
                Keep the old code
              </Button>
            </div>
          </div>
        ) : null}
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            keyHint="Ctrl+Enter"
            disabled={form.formState.isSubmitting}
          >
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
