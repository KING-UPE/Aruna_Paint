import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Merge, Trash2 } from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { IconButton } from '@/components/ui/icon-button';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';
import { useValues, type ValueListName } from '@/components/values';
import { api, errorMessage } from '@/lib/api';
import type { ValueItem } from '@/lib/types';
import { cn } from '@/lib/utils';

const LISTS: { list: ValueListName; label: string; usedIn: string }[] = [
  { list: 'categories', label: 'Categories', usedIn: 'Products, reports' },
  { list: 'brands', label: 'Brands', usedIn: 'Products, reports' },
  { list: 'units', label: 'Units', usedIn: 'Products' },
  { list: 'locations', label: 'Locations', usedIn: 'Purchases, stock, billing' },
  { list: 'reasons', label: 'Reasons', usedIn: 'Returns, adjustments, voids, cash out' },
  { list: 'cutoff-types', label: 'Cutoff types', usedIn: 'Monthly closing' },
];
const USES = ['RETURN', 'ADJUSTMENT', 'VOID', 'CASH_IN', 'CASH_OUT', 'PURCHASE_RETURN'];

/**
 * One screen manages every dropdown list, so the same value is never typed two different ways.
 * A value in use can't be deleted, only deactivated; duplicates can be merged.
 */
export function ValueManagerPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [tab, setTab] = useState<ValueListName>('categories');
  const values = useValues(tab, true);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [mergeFrom, setMergeFrom] = useState<ValueItem | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['values', tab] });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast.success(ok);
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const items = values.data?.items ?? [];
  const isLoc = tab === 'locations';
  const canEditList = isLoc ? can('settings.edit') : can('values.edit');

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Value manager"
        description="Names are unique, ignoring capital letters and extra spaces. Only the Super Admin adds shops or warehouses."
      />
      <div className="flex flex-wrap gap-1" role="tablist">
        {LISTS.map((l) => (
          <button
            key={l.list}
            role="tab"
            aria-selected={tab === l.list}
            onClick={() => setTab(l.list)}
            className={cn(
              'rounded-[8px] px-3 py-1.5 text-sm',
              tab === l.list
                ? 'bg-accent text-accent-text'
                : 'border border-border bg-surface hover:bg-surface-2',
            )}
          >
            {l.label}
          </button>
        ))}
      </div>
      <Card>
        <CardBody className="flex flex-col gap-3">
          <p className="text-sm text-muted">Used in: {LISTS.find((l) => l.list === tab)?.usedIn}</p>
          {canEditList || can('values.create') ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run(
                  () =>
                    api.post(
                      `/api/values/${tab}`,
                      isLoc ? { name, code, kind: 'WAREHOUSE' } : { name },
                    ),
                  `${name} added.`,
                ).then(() => {
                  setName('');
                  setCode('');
                });
              }}
            >
              <Input
                placeholder={`New ${LISTS.find((l) => l.list === tab)
                  ?.label.toLowerCase()
                  .replace(/s$/, '')}`}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="max-w-sm"
              />
              {isLoc ? (
                <Input
                  placeholder="Code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-28"
                />
              ) : null}
              <Button type="submit" variant="primary" disabled={!name.trim()}>
                Add
              </Button>
            </form>
          ) : null}
          <table className="w-full text-sm">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1.5 font-medium">Order</th>
                <th className="font-medium">Name</th>
                {tab === 'units' ? <th className="font-medium">Decimals</th> : null}
                {tab === 'reasons' ? <th className="font-medium">Used for</th> : null}
                {isLoc ? <th className="font-medium">Kind</th> : null}
                <th className="font-medium">Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((v, i) => (
                <tr key={v.id} className="border-t border-border">
                  <td className="py-1.5">
                    <div className="flex gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label="Move up"
                        disabled={i === 0 || !canEditList}
                        onClick={() => {
                          const ids = items.map((x) => x.id);
                          [ids[i - 1], ids[i]] = [ids[i]!, ids[i - 1]!];
                          void run(
                            () => api.put(`/api/values/${tab}/order`, { ids }),
                            'Order saved.',
                          );
                        }}
                      >
                        ↑
                      </Button>
                    </div>
                  </td>
                  <td>
                    <InlineName
                      value={v.name}
                      disabled={!canEditList}
                      onSave={(n) =>
                        run(() => api.patch(`/api/values/${tab}/${v.id}`, { name: n }), 'Renamed.')
                      }
                    />
                    {v.code ? <span className="ml-2 text-muted">{v.code}</span> : null}
                  </td>
                  {tab === 'units' ? (
                    <td>
                      <Checkbox
                        checked={v.allowsDecimal}
                        disabled={!canEditList}
                        onChange={(e) =>
                          void run(
                            () =>
                              api.patch(`/api/values/${tab}/${v.id}`, {
                                allowsDecimal: e.target.checked,
                              }),
                            'Saved.',
                          )
                        }
                      />
                    </td>
                  ) : null}
                  {tab === 'reasons' ? (
                    <td className="flex flex-wrap gap-1 py-1.5">
                      {USES.map((u) => (
                        <label key={u} className="flex items-center gap-1 text-xs">
                          <Checkbox
                            checked={v.appliesTo?.includes(u)}
                            disabled={!canEditList}
                            onChange={(e) =>
                              void run(
                                () =>
                                  api.patch(`/api/values/${tab}/${v.id}`, {
                                    appliesTo: e.target.checked
                                      ? [...(v.appliesTo ?? []), u]
                                      : (v.appliesTo ?? []).filter((x) => x !== u),
                                  }),
                                'Saved.',
                              )
                            }
                          />
                          {u.replace('_', ' ').toLowerCase()}
                        </label>
                      ))}
                    </td>
                  ) : null}
                  {isLoc ? <td>{v.kind?.toLowerCase()}</td> : null}
                  <td>
                    <Checkbox
                      checked={v.active}
                      disabled={!canEditList}
                      onChange={(e) =>
                        void run(
                          () =>
                            api.patch(`/api/values/${tab}/${v.id}`, { active: e.target.checked }),
                          e.target.checked ? 'Activated.' : 'Deactivated.',
                        )
                      }
                    />
                    {!v.active ? <Badge className="ml-2">Inactive</Badge> : null}
                  </td>
                  <td className="text-right">
                    {canEditList && !isLoc ? (
                      <div className="flex justify-end gap-0.5">
                        <IconButton
                          label={`Merge ${v.name} into another`}
                          icon={<Merge size={16} />}
                          onClick={() => setMergeFrom(v)}
                        />
                        <IconButton
                          label={`Delete ${v.name}`}
                          tone="danger"
                          icon={<Trash2 size={16} />}
                          onClick={() =>
                            void run(() => api.delete(`/api/values/${tab}/${v.id}`), 'Deleted.')
                          }
                        />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {mergeFrom ? (
            <div className="flex items-center gap-2 rounded-[8px] bg-surface-2 p-3 text-sm">
              Merge <strong>{mergeFrom.name}</strong> into
              <Select
                autoFocus
                className="w-56"
                defaultValue=""
                onChange={(e) => {
                  const into = e.target.value;
                  if (!into) return;
                  void run(
                    () => api.post(`/api/values/${tab}/${mergeFrom.id}/merge`, { intoId: into }),
                    'Merged, history included.',
                  ).then(() => setMergeFrom(null));
                }}
              >
                <option value="">Pick…</option>
                {items
                  .filter((x) => x.id !== mergeFrom.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </Select>
              <Button size="sm" variant="ghost" onClick={() => setMergeFrom(null)}>
                Cancel
              </Button>
            </div>
          ) : null}
        </CardBody>
      </Card>
    </div>
  );
}

function InlineName({
  value,
  disabled,
  onSave,
}: {
  value: string;
  disabled: boolean;
  onSave: (v: string) => Promise<void>;
}) {
  const [v, setV] = useState(value);
  return (
    <input
      className="w-64 rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-border focus:border-accent focus:outline-none"
      value={v}
      disabled={disabled}
      aria-label="Name"
      onChange={(e) => setV(e.target.value)}
      onBlur={() => (v.trim() && v !== value ? void onSave(v) : setV(value))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setV(value);
      }}
    />
  );
}
