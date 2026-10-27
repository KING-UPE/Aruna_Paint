import {
  SECTION_LABELS,
  SPECIAL_PERMISSIONS,
  permissionGroups,
  type Permission,
  type SpecialPermission,
} from '@aruna/shared';
import { Lock } from 'lucide-react';
import { Checkbox } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const ACTION_LABELS: Record<string, string> = {
  view: 'View',
  create: 'Add',
  edit: 'Edit',
  approve: 'Approve',
  export: 'Export',
};

interface Row {
  key: string;
  label: string;
  items: { permission: Permission; label: string }[];
}

interface Group {
  key: string;
  label: string;
  rows: Row[];
}

function allGroups(): Group[] {
  const groups: Group[] = permissionGroups().map((g) => ({
    key: g.section,
    label: SECTION_LABELS[g.section],
    rows: g.modules.map((m) => ({
      key: m.key,
      label: m.label,
      items: m.permissions.map((p) => ({
        permission: p.permission,
        label: ACTION_LABELS[p.action] ?? p.action,
      })),
    })),
  }));
  groups.push({
    key: 'cost',
    label: 'Cost privacy',
    rows: (Object.keys(SPECIAL_PERMISSIONS) as SpecialPermission[]).map((p) => ({
      key: p,
      label: SPECIAL_PERMISSIONS[p].label,
      items: [{ permission: p, label: 'Can see' }],
    })),
  });
  return groups;
}

const GROUPS = allGroups();

export interface PermissionEditorProps {
  /** Is this permission ticked now? */
  checked: (p: Permission) => boolean;
  /** Tick or untick one or more permissions (a whole screen at once from its row checkbox). */
  onChange?: (perms: Permission[], on: boolean) => void;
  /** What it would be without changes (role defaults, or what the user's roles give). Differences get a dot. */
  baseline?: (p: Permission) => boolean;
  baselineLabel?: string;
  /** Can't be changed here, for example Super Admin-only permissions. */
  locked?: (p: Permission) => boolean;
  /** Show only these permissions (a role's own list). */
  only?: ReadonlySet<string>;
  readOnly?: boolean;
  className?: string;
}

/**
 * Every permission grouped by section and screen. Each screen has one checkbox for all of its
 * actions, and the actions as small toggles to set one by one.
 */
export function PermissionEditor({
  checked,
  onChange,
  baseline,
  baselineLabel = 'Changed from the default',
  locked,
  only,
  readOnly,
  className,
}: PermissionEditorProps) {
  const groups = GROUPS.map((g) => ({
    ...g,
    rows: g.rows
      .map((r) => ({ ...r, items: only ? r.items.filter((i) => only.has(i.permission)) : r.items }))
      .filter((r) => r.items.length > 0),
  })).filter((g) => g.rows.length > 0);

  if (!groups.length) {
    return <p className="py-2 text-sm text-muted">No permissions.</p>;
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {groups.map((g) => (
        <section key={g.key}>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">
            {g.label}
          </h4>
          <div className="divide-y divide-border rounded-[12px] border border-border">
            {g.rows.map((r) => {
              const editable = r.items.filter((i) => !locked?.(i.permission));
              const on = editable.filter((i) => checked(i.permission)).length;
              const all = editable.length > 0 && on === editable.length;
              const disabled = readOnly || !onChange || editable.length === 0;
              return (
                <div key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                  <label
                    className={cn(
                      'flex min-w-[12rem] flex-1 items-center gap-2.5 text-sm',
                      !disabled && 'cursor-pointer',
                    )}
                  >
                    <Checkbox
                      aria-label={`${r.label}: all`}
                      checked={all}
                      indeterminate={on > 0 && !all}
                      disabled={disabled}
                      onChange={() =>
                        onChange?.(
                          editable.map((i) => i.permission),
                          !all,
                        )
                      }
                    />
                    <span className="font-medium">{r.label}</span>
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {r.items.map((i) => (
                      <PermissionChip
                        key={i.permission}
                        label={i.label}
                        title={`${r.label}: ${i.label}`}
                        on={checked(i.permission)}
                        changed={
                          baseline ? baseline(i.permission) !== checked(i.permission) : false
                        }
                        changedLabel={baselineLabel}
                        locked={locked?.(i.permission) ?? false}
                        disabled={disabled}
                        onToggle={() => onChange?.([i.permission], !checked(i.permission))}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function PermissionChip({
  label,
  title,
  on,
  changed,
  changedLabel,
  locked,
  disabled,
  onToggle,
}: {
  label: string;
  title: string;
  on: boolean;
  changed: boolean;
  changedLabel: string;
  locked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const off = disabled || locked;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={title}
      title={locked ? 'Only the Super Admin can have this' : changed ? changedLabel : undefined}
      disabled={off}
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[13px] transition-colors',
        on
          ? 'border-accent/40 bg-accent-soft font-medium text-accent-strong'
          : 'border-border bg-surface text-muted',
        !off && (on ? 'hover:border-accent' : 'hover:border-muted/60 hover:text-text'),
        off && 'cursor-default',
        locked && 'opacity-60',
      )}
    >
      {locked ? <Lock size={11} aria-hidden /> : null}
      {label}
      {changed ? (
        <span
          aria-hidden
          className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-surface bg-warn"
        />
      ) : null}
    </button>
  );
}

/** How many permissions differ from a baseline, for "3 changes" labels. */
export function countChanges(
  checked: (p: Permission) => boolean,
  baseline: (p: Permission) => boolean,
  only?: ReadonlySet<string>,
): number {
  let n = 0;
  for (const g of GROUPS)
    for (const r of g.rows)
      for (const i of r.items) {
        if (only && !only.has(i.permission)) continue;
        if (checked(i.permission) !== baseline(i.permission)) n++;
      }
  return n;
}
