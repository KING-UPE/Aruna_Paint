import {
  SECTION_LABELS,
  SPECIAL_PERMISSIONS,
  permissionGroups,
  type Permission,
  type SpecialPermission,
} from '@aruna/shared';
import {
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  Eye,
  Lock,
  Pencil,
  Plus,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Checkbox } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const ACTIONS: Record<string, { label: string; icon: LucideIcon }> = {
  view: { label: 'View', icon: Eye },
  create: { label: 'Add', icon: Plus },
  edit: { label: 'Edit', icon: Pencil },
  approve: { label: 'Approve', icon: ShieldCheck },
  export: { label: 'Export', icon: Download },
};

interface Row {
  key: string;
  label: string;
  items: { permission: Permission; label: string; icon: LucideIcon }[];
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
        label: ACTIONS[p.action]?.label ?? p.action,
        icon: ACTIONS[p.action]?.icon ?? Eye,
      })),
    })),
  }));
  groups.push({
    key: 'cost',
    label: 'Cost privacy',
    rows: (Object.keys(SPECIAL_PERMISSIONS) as SpecialPermission[]).map((p) => ({
      key: p,
      label: SPECIAL_PERMISSIONS[p].label,
      items: [{ permission: p, label: 'Can see', icon: Eye }],
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
  /** Sections start open (short lists) or closed (the full list). */
  defaultOpen?: boolean;
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
  defaultOpen = false,
  className,
}: PermissionEditorProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const groups = GROUPS.map((g) => ({
    ...g,
    rows: g.rows
      .map((r) => ({ ...r, items: only ? r.items.filter((i) => only.has(i.permission)) : r.items }))
      .filter((r) => r.items.length > 0),
  })).filter((g) => g.rows.length > 0);

  if (!groups.length) {
    return <p className="py-2 text-sm text-muted">No permissions.</p>;
  }

  const isOpen = (key: string) => open[key] ?? defaultOpen;
  const allOpen = groups.every((g) => isOpen(g.key));
  const setAll = (value: boolean) => setOpen(Object.fromEntries(groups.map((g) => [g.key, value])));

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {groups.length > 1 ? (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setAll(!allOpen)}
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-muted hover:bg-surface-2 hover:text-text"
          >
            {allOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
            {allOpen ? 'Close all' : 'Open all'}
          </button>
        </div>
      ) : null}
      {groups.map((g) => {
        const items = g.rows.flatMap((r) => r.items);
        const editable = items.filter((i) => !locked?.(i.permission));
        const onCount = items.filter((i) => checked(i.permission)).length;
        const editableOn = editable.filter((i) => checked(i.permission)).length;
        const allOn = editable.length > 0 && editableOn === editable.length;
        const changes = baseline
          ? items.filter((i) => baseline(i.permission) !== checked(i.permission)).length
          : 0;
        const disabled = readOnly || !onChange || editable.length === 0;
        const expanded = isOpen(g.key);
        const bodyId = `perm-section-${g.key}`;
        return (
          <section key={g.key} className="rounded-[12px] border border-border">
            <div
              className={cn(
                'flex items-center gap-2 px-2 py-1.5',
                expanded && 'border-b border-border',
              )}
            >
              <button
                type="button"
                aria-expanded={expanded}
                aria-controls={bodyId}
                onClick={() => setOpen((o) => ({ ...o, [g.key]: !expanded }))}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] px-1.5 py-1 text-left hover:bg-surface-2"
              >
                <ChevronDown
                  size={16}
                  aria-hidden
                  className={cn(
                    'shrink-0 text-muted transition-transform',
                    !expanded && '-rotate-90',
                  )}
                />
                <span className="text-xs font-semibold uppercase tracking-wide">{g.label}</span>
                <span className="text-xs text-muted">
                  {onCount} of {items.length}
                </span>
                {changes ? (
                  <span className="rounded-full bg-warn-soft px-1.5 text-[11px] font-semibold text-warn">
                    {changes === 1 ? '1 change' : `${changes} changes`}
                  </span>
                ) : null}
              </button>
              {!disabled ? (
                <label className="flex cursor-pointer items-center gap-2 px-1.5 text-xs text-muted">
                  All
                  <Checkbox
                    aria-label={`${g.label}: everything`}
                    checked={allOn}
                    indeterminate={editableOn > 0 && !allOn}
                    onChange={() =>
                      onChange?.(
                        editable.map((i) => i.permission),
                        !allOn,
                      )
                    }
                  />
                </label>
              ) : null}
            </div>
            {expanded ? (
              <div id={bodyId} className="divide-y divide-border">
                {g.rows.map((r) => {
                  const rowEditable = r.items.filter((i) => !locked?.(i.permission));
                  const on = rowEditable.filter((i) => checked(i.permission)).length;
                  const all = rowEditable.length > 0 && on === rowEditable.length;
                  const rowDisabled = disabled || rowEditable.length === 0;
                  return (
                    <div
                      key={r.key}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
                    >
                      <label
                        className={cn(
                          'flex min-w-[12rem] flex-1 items-center gap-2.5 text-sm',
                          !rowDisabled && 'cursor-pointer',
                        )}
                      >
                        <Checkbox
                          aria-label={`${r.label}: all`}
                          checked={all}
                          indeterminate={on > 0 && !all}
                          disabled={rowDisabled}
                          onChange={() =>
                            onChange?.(
                              rowEditable.map((i) => i.permission),
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
                            icon={i.icon}
                            title={`${r.label}: ${i.label}`}
                            on={checked(i.permission)}
                            changed={
                              baseline ? baseline(i.permission) !== checked(i.permission) : false
                            }
                            changedLabel={baselineLabel}
                            locked={locked?.(i.permission) ?? false}
                            disabled={rowDisabled}
                            onToggle={() => onChange?.([i.permission], !checked(i.permission))}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function PermissionChip({
  label,
  icon: Icon,
  title,
  on,
  changed,
  changedLabel,
  locked,
  disabled,
  onToggle,
}: {
  label: string;
  icon: LucideIcon;
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
      {locked ? <Lock size={12} aria-hidden /> : <Icon size={13} aria-hidden />}
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
