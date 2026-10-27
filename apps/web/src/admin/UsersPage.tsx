import {
  ALL_PERMISSIONS,
  BUILT_IN_ROLE_LABELS,
  formatDateTime,
  isSuperAdminOnly,
  type Permission,
} from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCheck,
  ChevronDown,
  EyeOff,
  KeyRound,
  ListChecks,
  Pencil,
  RectangleEllipsis,
  RotateCcw,
  ShieldPlus,
  Trash2,
  Undo2,
  UserPlus,
  X,
} from 'lucide-react';
import { useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { useAsk, useConfirm } from '@/components/AskDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Field } from '@/components/ui/field';
import { Checkbox, Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { PermissionEditor, countChanges } from './PermissionEditor';

interface Override {
  permission: string;
  granted: boolean;
}
interface UserRow {
  id: string;
  username: string;
  fullName: string;
  active: boolean;
  mustChangePassword: boolean;
  hasPin: boolean;
  commissionRate: string | null;
  lastLoginAt: string | null;
  roles: { id: string; code: string; name: string }[];
  permissionOverrides: Override[];
}
interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string;
  builtIn: boolean;
  /** A built-in role whose permissions the Super Admin changed. */
  customized: boolean;
  userCount: number;
  /** What the role gives now. */
  permissions: string[];
  /** What a built-in role gives out of the box; null for roles made here. */
  defaultPermissions: string[] | null;
}

const roleLabel = (r: { code: string; name: string }) =>
  BUILT_IN_ROLE_LABELS[r.code as keyof typeof BUILT_IN_ROLE_LABELS] ?? r.name;

const isSuperAdminRole = (r: { code: string; name: string }) =>
  r.code === 'SUPER_ADMIN' ||
  r.name.toLowerCase() === 'super admin' ||
  r.name.toLowerCase() === 'super_admin';

/**
 * The Super Admin registers every user and ticks their roles; one person can hold several.
 * Each role can be opened to see its permissions and changed one by one, for everyone with the
 * role or for one user only.
 */
export function UsersPage() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const ask = useAsk();
  const users = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<{ items: UserRow[] }>('/api/users'),
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<{ items: RoleRow[] }>('/api/roles'),
  });
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [roleEditing, setRoleEditing] = useState<RoleRow | 'new' | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['users'] });
    void qc.invalidateQueries({ queryKey: ['roles'] });
  };
  const isSuperAdmin = (u: UserRow) => u.roles.some(isSuperAdminRole);
  const deleteUser = async (u: UserRow) => {
    const ok = await confirm({
      title: 'Delete user?',
      message: `${u.fullName} (${u.username}) will be removed. This can't be undone.`,
      confirmLabel: 'Delete user',
      danger: true,
    });
    if (!ok) return false;
    try {
      await api.delete(`/api/users/${u.id}`);
      toast.success(`User "${u.fullName}" deleted.`);
      refresh();
      return true;
    } catch (err) {
      toast.error(errorMessage(err));
      return false;
    }
  };
  const reset = async (u: UserRow, what: 'password' | 'pin') => {
    const value = await ask(
      what === 'password'
        ? {
            title: `Reset password for ${u.fullName}`,
            label: 'New password',
            hint: 'At least 8 characters. They change it at next login.',
            type: 'password',
            confirmLabel: 'Reset password',
            check: (v) => (v.length < 8 ? 'Use at least 8 characters.' : null),
          }
        : {
            title: `Reset PIN for ${u.fullName}`,
            label: 'New PIN',
            hint: '4 to 6 digits, unique per user.',
            type: 'password',
            inputMode: 'numeric',
            confirmLabel: 'Reset PIN',
            check: (v) => (v.length < 4 || v.length > 6 ? 'A PIN has 4 to 6 digits.' : null),
          },
    );
    if (!value) return;
    try {
      await api.post(
        `/api/users/${u.id}/reset-${what}`,
        what === 'password' ? { password: value } : { pin: value },
      );
      toast.success(
        what === 'password' ? 'Password reset. They must change it at next login.' : 'PIN reset.',
      );
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Users and roles"
        description="At least one active Super Admin must always exist."
      >
        <Button icon={<ShieldPlus size={16} />} onClick={() => setRoleEditing('new')}>
          New role
        </Button>
        <Button variant="primary" icon={<UserPlus size={16} />} onClick={() => setEditing('new')}>
          New user
        </Button>
      </PageHeader>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-muted">
            <tr>
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Username</th>
              <th className="px-4 py-2.5 font-medium">Roles</th>
              <th className="px-4 py-2.5 font-medium">Last login</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {(users.data?.items ?? []).map((u) => {
              const added = u.permissionOverrides.filter((o) => o.granted).length;
              const removed = u.permissionOverrides.length - added;
              return (
                <tr key={u.id} className="border-t border-border">
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{u.fullName}</span>
                      {!u.active ? <Badge>Disabled</Badge> : null}
                      {!u.hasPin ? <Badge tone="warn">No PIN</Badge> : null}
                    </div>
                  </td>
                  <td className="px-4 py-2.5">{u.username}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-1">
                      {u.roles.map((r) => (
                        <Badge key={r.id} tone="accent">
                          {roleLabel(r)}
                        </Badge>
                      ))}
                      {added || removed ? (
                        <Badge tone="warn" title="Permissions changed for this user only">
                          Own:{' '}
                          {[added ? `+${added}` : '', removed ? `−${removed}` : '']
                            .filter(Boolean)
                            .join(' ')}
                        </Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '—'}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <IconButton
                        label={`Edit ${u.fullName}`}
                        icon={<Pencil size={16} />}
                        onClick={() => setEditing(u)}
                      />
                      <IconButton
                        label="Reset password"
                        icon={<KeyRound size={16} />}
                        onClick={() => void reset(u, 'password')}
                      />
                      <IconButton
                        label="Reset PIN"
                        icon={<RectangleEllipsis size={16} />}
                        onClick={() => void reset(u, 'pin')}
                      />
                      {/* Keeps the icons lined up when a Super Admin row has no delete. */}
                      {!isSuperAdmin(u) ? (
                        <IconButton
                          label={`Delete ${u.fullName}`}
                          tone="danger"
                          icon={<Trash2 size={16} />}
                          onClick={() => void deleteUser(u)}
                        />
                      ) : (
                        <span className="w-8" aria-hidden />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
          <span className="text-sm text-muted">Open a role to see what it allows.</span>
        </CardHeader>
        <CardBody className="flex flex-col gap-2">
          {(roles.data?.items ?? []).map((r) => (
            <RoleCard
              key={r.id}
              role={r}
              onEdit={() => setRoleEditing(r)}
              onDelete={async () => {
                const ok = await confirm({
                  title: 'Delete role?',
                  message: `The role "${r.name}" will be removed.`,
                  confirmLabel: 'Delete role',
                  danger: true,
                });
                if (!ok) return;
                try {
                  await api.delete(`/api/roles/${r.id}`);
                  refresh();
                } catch (err) {
                  toast.error(errorMessage(err));
                }
              }}
            />
          ))}
        </CardBody>
      </Card>
      <UserDialog
        user={editing}
        roles={roles.data?.items ?? []}
        onClose={() => setEditing(null)}
        onDone={refresh}
        onDelete={async (u) => {
          if (await deleteUser(u)) setEditing(null);
        }}
      />
      <RoleDialog role={roleEditing} onClose={() => setRoleEditing(null)} onDone={refresh} />
    </div>
  );
}

/** A role as a row that opens to show its permissions. */
function RoleCard({
  role: r,
  onEdit,
  onDelete,
}: {
  role: RoleRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const sa = r.code === 'SUPER_ADMIN';
  const perms = new Set(r.permissions);
  return (
    <div className="rounded-[12px] border border-border">
      <div className="flex items-center gap-3 px-3 py-2">
        <ExpandButton open={open} onClick={() => setOpen(!open)} label={roleLabel(r)} />
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
        >
          <span className="font-semibold">{roleLabel(r)}</span>
          {r.builtIn ? <Badge>Built in</Badge> : null}
          {r.customized ? <Badge tone="warn">Changed</Badge> : null}
          <span className="text-sm text-muted">
            {sa ? 'Every permission' : `${r.permissions.length} permissions`} ·{' '}
            {r.userCount === 1 ? '1 user' : `${r.userCount} users`}
          </span>
        </button>
        {!sa ? (
          <div className="flex gap-0.5">
            <IconButton
              label={`Edit ${roleLabel(r)} permissions`}
              icon={<Pencil size={16} />}
              onClick={onEdit}
            />
            {!r.builtIn ? (
              <IconButton
                label={`Delete ${roleLabel(r)}`}
                tone="danger"
                icon={<Trash2 size={16} />}
                onClick={onDelete}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      {open ? (
        <div className="border-t border-border px-3 py-3">
          {sa ? (
            <p className="text-sm text-muted">
              The Super Admin always has every permission, including users, settings, backups and
              cost totals.
            </p>
          ) : (
            <PermissionEditor checked={(p) => perms.has(p)} only={perms} readOnly />
          )}
        </div>
      ) : null}
    </div>
  );
}

function ExpandButton({
  open,
  onClick,
  label,
}: {
  open: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`${open ? 'Hide' : 'Show'} permissions of ${label}`}
      onClick={onClick}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-text"
    >
      <ChevronDown size={16} className={cn('transition-transform', !open && '-rotate-90')} />
    </button>
  );
}

function Section({
  title,
  description,
  aside,
  children,
}: {
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          {description ? <p className="text-sm text-muted">{description}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function UserDialog({
  user,
  roles,
  onClose,
  onDone,
  onDelete,
}: {
  user: UserRow | 'new' | null;
  roles: RoleRow[];
  onClose: () => void;
  onDone: () => void;
  onDelete: (u: UserRow) => void;
}) {
  const isNew = user === 'new';
  const u = user && user !== 'new' ? user : null;
  const [f, setF] = useState({
    username: '',
    fullName: '',
    password: '',
    pin: '',
    commissionRate: '',
    active: true,
    roleIds: [] as string[],
  });
  // This user's own changes on top of their roles: true adds a permission, false takes it away.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [openRoles, setOpenRoles] = useState<Set<string>>(new Set());
  const [showOwn, setShowOwn] = useState(false);
  const [error, setError] = useState('');
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const key = isNew ? 'new' : (u?.id ?? null);
  if (user && loadedFor !== key) {
    setLoadedFor(key);
    setError('');
    setOpenRoles(new Set());
    setOverrides(new Map((u?.permissionOverrides ?? []).map((o) => [o.permission, o.granted])));
    setShowOwn(Boolean(u?.permissionOverrides.length));
    setF(
      u
        ? {
            username: u.username,
            fullName: u.fullName,
            password: '',
            pin: '',
            commissionRate: u.commissionRate ?? '',
            active: u.active,
            roleIds: u.roles.map((r) => r.id),
          }
        : {
            username: '',
            fullName: '',
            password: '',
            pin: '',
            commissionRate: '',
            active: true,
            roleIds: [],
          },
    );
  }

  const ticked = roles.filter((r) => f.roleIds.includes(r.id));
  const superAdmin = ticked.some((r) => r.code === 'SUPER_ADMIN');
  const fromRoles = new Set(ticked.flatMap((r) => r.permissions));
  const effective = (p: Permission) => overrides.get(p) ?? fromRoles.has(p);
  const locked = (p: Permission) => isSuperAdminOnly(p);
  const setPerms = (perms: Permission[], on: boolean) =>
    setOverrides((prev) => {
      const next = new Map(prev);
      for (const p of perms) {
        if (on === fromRoles.has(p)) next.delete(p);
        else next.set(p, on);
      }
      return next;
    });
  // Only real differences from the ticked roles are kept.
  const ownChanges = superAdmin
    ? []
    : [...overrides]
        .filter(([p, granted]) => granted !== fromRoles.has(p) && !locked(p as Permission))
        .map(([permission, granted]) => ({ permission, granted }));
  const changeCount = ownChanges.length;

  const close = () => {
    onClose();
    setLoadedFor(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (isNew) {
        await api.post('/api/users', {
          username: f.username,
          fullName: f.fullName,
          password: f.password,
          pin: f.pin || null,
          roleIds: f.roleIds,
          commissionRate: f.commissionRate || null,
          permissionOverrides: ownChanges,
        });
      } else {
        await api.patch(`/api/users/${u!.id}`, {
          fullName: f.fullName,
          active: f.active,
          roleIds: f.roleIds,
          commissionRate: f.commissionRate || null,
          permissionOverrides: ownChanges,
        });
      }
      toast.success('User saved.');
      onDone();
      close();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const toggleOpen = (id: string) =>
    setOpenRoles((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog
      open={Boolean(user)}
      onOpenChange={(o) => (!o ? close() : undefined)}
      title={isNew ? 'New user' : `Edit ${u?.fullName ?? ''}`}
      className="max-w-3xl"
    >
      <form onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid gap-3 sm:grid-cols-2">
          {isNew ? (
            <Field label="Username">
              <Input
                autoFocus
                value={f.username}
                onChange={(e) => setF({ ...f, username: e.target.value })}
              />
            </Field>
          ) : null}
          <Field label="Full name">
            <Input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
          </Field>
          {isNew ? (
            <>
              <Field label="Password" hint="At least 8 characters; they change it at first login.">
                <Input
                  type="password"
                  value={f.password}
                  onChange={(e) => setF({ ...f, password: e.target.value })}
                />
              </Field>
              <Field label="PIN" hint="4 to 6 digits, unique per user.">
                <Input
                  inputMode="numeric"
                  value={f.pin}
                  onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })}
                />
              </Field>
            </>
          ) : null}
          <Field label="Commission rate (%)" hint="On their net sales.">
            <Input
              className="num"
              inputMode="decimal"
              value={f.commissionRate}
              onChange={(e) => setF({ ...f, commissionRate: e.target.value })}
            />
          </Field>
          {!isNew ? (
            <label className="flex items-center gap-2.5 self-center text-sm sm:pt-5">
              <Checkbox
                checked={f.active}
                onChange={(e) => setF({ ...f, active: e.target.checked })}
              />
              Active
            </label>
          ) : null}
        </div>

        <Section
          title="Roles"
          description="Ticking a role gives all of its permissions. Open a role to change single permissions for this user."
        >
          <div className="flex flex-col gap-2">
            {roles.map((r) => {
              const on = f.roleIds.includes(r.id);
              const open = openRoles.has(r.id);
              const sa = r.code === 'SUPER_ADMIN';
              const own = new Set(r.permissions);
              const changedHere =
                on && !superAdmin ? countChanges(effective, (p) => fromRoles.has(p), own) : 0;
              return (
                <div
                  key={r.id}
                  className={cn(
                    'rounded-[12px] border transition-colors',
                    on ? 'border-accent/40 bg-accent-soft/40' : 'border-border',
                  )}
                >
                  <div className="flex items-center gap-3 px-3 py-2">
                    <ExpandButton
                      open={open}
                      onClick={() => toggleOpen(r.id)}
                      label={roleLabel(r)}
                    />
                    <label className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-2.5">
                      <Checkbox
                        checked={on}
                        onChange={(e) =>
                          setF({
                            ...f,
                            roleIds: e.target.checked
                              ? [...f.roleIds, r.id]
                              : f.roleIds.filter((x) => x !== r.id),
                          })
                        }
                      />
                      <span className="font-medium">{roleLabel(r)}</span>
                      <span className="text-sm text-muted">
                        {sa ? 'Every permission' : `${r.permissions.length} permissions`}
                      </span>
                      {changedHere ? (
                        <Badge tone="warn">
                          {changedHere === 1 ? '1 change' : `${changedHere} changes`} for this user
                        </Badge>
                      ) : null}
                    </label>
                  </div>
                  {open ? (
                    <div className="border-t border-border bg-surface px-3 py-3 [border-radius:0_0_12px_12px]">
                      {sa ? (
                        <p className="text-sm text-muted">
                          The Super Admin always has every permission.
                        </p>
                      ) : (
                        <>
                          {!on ? (
                            <p className="mb-3 text-sm text-muted">
                              What {roleLabel(r)} allows. Tick the role to give all of these.
                            </p>
                          ) : superAdmin ? (
                            <p className="mb-3 text-sm text-muted">
                              This user is a Super Admin, so they have everything anyway.
                            </p>
                          ) : null}
                          <PermissionEditor
                            only={own}
                            checked={on && !superAdmin ? effective : (p) => own.has(p)}
                            baseline={on && !superAdmin ? (p) => fromRoles.has(p) : undefined}
                            baselineLabel="Changed for this user"
                            locked={locked}
                            readOnly={!on || superAdmin}
                            onChange={setPerms}
                          />
                        </>
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </Section>

        {!superAdmin ? (
          <Section
            title="Permissions for this user only"
            description="Add a permission none of their roles give, or take one away."
            aside={
              <div className="flex items-center gap-2">
                {changeCount ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    icon={<Undo2 size={15} />}
                    onClick={() => setOverrides(new Map())}
                  >
                    Undo {changeCount === 1 ? '1 change' : `${changeCount} changes`}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  icon={showOwn ? <EyeOff size={15} /> : <ListChecks size={15} />}
                  onClick={() => setShowOwn(!showOwn)}
                >
                  {showOwn ? 'Hide' : 'Show all permissions'}
                </Button>
              </div>
            }
          >
            {showOwn ? (
              <PermissionEditor
                checked={effective}
                baseline={(p) => fromRoles.has(p)}
                baselineLabel="Changed for this user"
                locked={locked}
                onChange={setPerms}
              />
            ) : null}
          </Section>
        ) : null}

        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
          <div>
            {!isNew && u && !u.roles.some(isSuperAdminRole) ? (
              <Button
                type="button"
                variant="ghost"
                className="text-danger hover:bg-danger/10 hover:text-danger"
                icon={<Trash2 size={16} />}
                onClick={() => onDelete(u)}
              >
                Delete user
              </Button>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={close}>
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

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));

/**
 * A role made here: a name and its permissions. A built-in role keeps its name, but the Super
 * Admin can change its permissions for everyone who has it, and put the defaults back.
 */
function RoleDialog({
  role,
  onClose,
  onDone,
}: {
  role: RoleRow | 'new' | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const r = role && role !== 'new' ? role : null;
  const [name, setName] = useState('');
  const [perms, setPerms] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState<string | null>(null);
  const [error, setError] = useState('');
  const key = role === 'new' ? 'new' : (r?.id ?? null);
  if (role && loaded !== key) {
    setLoaded(key);
    setName(r?.name ?? '');
    setPerms(new Set(r?.permissions ?? []));
    setError('');
  }
  const defaults = r?.defaultPermissions ? new Set(r.defaultPermissions) : null;
  const locked = (p: Permission) => isSuperAdminOnly(p) && !defaults?.has(p);
  const atDefaults = defaults ? sameSet(perms, defaults) : false;
  const changes = defaults
    ? countChanges(
        (p) => perms.has(p),
        (p) => defaults.has(p),
      )
    : 0;

  const close = () => {
    onClose();
    setLoaded(null);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (r?.builtIn && atDefaults) await api.post(`/api/roles/${r.id}/reset`);
      else if (r?.builtIn) await api.patch(`/api/roles/${r.id}`, { permissions: [...perms] });
      else if (r) await api.patch(`/api/roles/${r.id}`, { name, permissions: [...perms] });
      else await api.post('/api/roles', { name, permissions: [...perms] });
      toast.success('Role saved.');
      onDone();
      close();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const change = (list: Permission[], on: boolean) =>
    setPerms((s) => {
      const next = new Set(s);
      for (const p of list) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  return (
    <Dialog
      open={Boolean(role)}
      onOpenChange={(o) => (!o ? close() : undefined)}
      title={r?.builtIn ? `${roleLabel(r)} permissions` : r ? `Edit ${r.name}` : 'New role'}
      description={
        r
          ? `Changes apply to everyone with this role (${r.userCount === 1 ? '1 user' : `${r.userCount} users`}).`
          : 'The new role appears as another checkbox when you edit a user.'
      }
      className="max-w-3xl"
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        {!r?.builtIn ? (
          <Field label="Name">
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-muted">
            {perms.size} of {ALL_PERMISSIONS.filter((p) => !locked(p)).length} permissions
            {defaults && changes ? (
              <>
                {' · '}
                <span className="text-warn">
                  {changes === 1 ? '1 change' : `${changes} changes`} from the default
                </span>
              </>
            ) : null}
          </span>
          <div className="flex gap-2">
            {defaults && !atDefaults ? (
              <Button
                type="button"
                size="sm"
                icon={<RotateCcw size={15} />}
                onClick={() => setPerms(new Set(defaults))}
              >
                Back to default
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon={<CheckCheck size={15} />}
              onClick={() =>
                change(
                  ALL_PERMISSIONS.filter((p) => !locked(p)),
                  true,
                )
              }
            >
              Tick all
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              icon={<X size={15} />}
              onClick={() => setPerms(new Set())}
            >
              Clear
            </Button>
          </div>
        </div>
        <PermissionEditor
          checked={(p) => perms.has(p)}
          onChange={change}
          baseline={defaults ? (p) => defaults.has(p) : undefined}
          locked={locked}
        />
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button type="button" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save role
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
