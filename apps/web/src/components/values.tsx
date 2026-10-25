import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { api, errorMessage } from '@/lib/api';
import type { ValueItem } from '@/lib/types';
import { Select } from './ui/input';

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

/**
 * One dropdown for every value list, so the same value is never typed two different ways.
 * Typing a new value offers "+ Add" right there, if the role allows it.
 */
export function ValueSelect({
  list,
  value,
  onChange,
  allowEmpty = true,
  id,
  invalid,
}: {
  list: ValueListName;
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  allowEmpty?: boolean;
  id?: string;
  invalid?: boolean;
}) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useValues(list);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const canAdd = can('values.create') && list !== 'locations';

  if (adding) {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex gap-2">
          <input
            autoFocus
            className="h-10 w-full rounded-[var(--radius-input)] border border-accent bg-surface px-3"
            placeholder="New value"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setAdding(false);
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                try {
                  const row = await api.post<ValueItem>(`/api/values/${list}`, { name });
                  await qc.invalidateQueries({ queryKey: ['values', list] });
                  onChange(row.id);
                  setAdding(false);
                  setName('');
                } catch (err) {
                  setError(errorMessage(err));
                }
              }
            }}
          />
        </div>
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : (
          <p className="text-xs text-muted">Enter adds it, Esc cancels.</p>
        )}
      </div>
    );
  }

  return (
    <Select
      id={id}
      aria-invalid={invalid || undefined}
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value === '__add') {
          setAdding(true);
          return;
        }
        onChange(e.target.value || null);
      }}
    >
      {allowEmpty ? <option value="">—</option> : null}
      {(q.data?.items ?? []).map((v) => (
        <option key={v.id} value={v.id}>
          {v.name}
        </option>
      ))}
      {canAdd ? <option value="__add">+ Add…</option> : null}
    </Select>
  );
}
