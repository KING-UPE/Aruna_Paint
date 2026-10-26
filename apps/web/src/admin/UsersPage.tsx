import {
  BUILT_IN_ROLE_LABELS,
  MODULES,
  SPECIAL_PERMISSIONS,
  assignablePermissions,
  formatDateTime,
  type ModuleKey,
} from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Checkbox, Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

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
}
interface RoleRow {
  id: string;
  code: string;
  name: string;
  description: string;
  builtIn: boolean;
  userCount: number;
  permissions: string[];
}

/**
 * The Super Admin registers every user and ticks their roles; one person can hold several.
 * A role built here appears as another checkbox.
 */
export function UsersPage() {
  const qc = useQueryClient();
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
  const isSuperAdmin = (u: UserRow) =>
    u.roles.some(
      (r) =>
        r.code === 'SUPER_ADMIN' ||
        r.name.toLowerCase() === 'super admin' ||
        r.name.toLowerCase() === 'super_admin',
    );
  const deleteUser = async (u: UserRow) => {
    if (!window.confirm(`Are you sure you want to delete user "${u.fullName}" (${u.username})?`)) {
      return;
    }
    try {
      await api.delete(`/api/users/${u.id}`);
      toast.success(`User "${u.fullName}" deleted.`);
      refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const reset = async (u: UserRow, what: 'password' | 'pin') => {
    const value = window.prompt(
      what === 'password'
        ? `New password for ${u.fullName} (they change it at next login)`
        : `New PIN for ${u.fullName} (4 to 6 digits)`,
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
        <Button onClick={() => setRoleEditing('new')}>New role</Button>
        <Button variant="primary" onClick={() => setEditing('new')}>
          New user
        </Button>
      </PageHeader>
      <Card>
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Username</th>
              <th className="px-4 py-2 font-medium">Roles</th>
              <th className="px-4 py-2 font-medium">Last login</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {(users.data?.items ?? []).map((u) => (
              <tr key={u.id} className="border-t border-border">
                <td className="px-4 py-2 font-medium">
                  {u.fullName} {!u.active ? <Badge>Disabled</Badge> : null}{' '}
                  {!u.hasPin ? <Badge tone="warn">No PIN</Badge> : null}
                </td>
                <td className="px-4 py-2">{u.username}</td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    {u.roles.map((r) => (
                      <Badge key={r.id} tone="accent">
                        {r.name}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2 text-muted">
                  {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : '—'}
                </td>
                <td className="px-4 py-2 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(u)}>
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void reset(u, 'password')}>
                      Reset password
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void reset(u, 'pin')}>
                      Reset PIN
                    </Button>
                    {!isSuperAdmin(u) ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger hover:bg-danger/10 hover:text-danger"
                        onClick={() => void deleteUser(u)}
                      >
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
        </CardHeader>
        <CardBody className="grid gap-3 md:grid-cols-2">
          {(roles.data?.items ?? []).map((r) => (
            <div key={r.id} className="rounded-[8px] border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold">{r.name}</span>
                <span className="text-sm text-muted">
                  {r.userCount} users {r.builtIn ? <Badge>built in</Badge> : null}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted">{r.permissions.length} permissions</p>
              {!r.builtIn ? (
                <div className="mt-2 flex gap-2">
                  <Button size="sm" onClick={() => setRoleEditing(r)}>
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await api.delete(`/api/roles/${r.id}`);
                        refresh();
                      } catch (err) {
                        toast.error(errorMessage(err));
                      }
                    }}
                  >
                    Delete
                  </Button>
                </div>
              ) : null}
            </div>
          ))}
        </CardBody>
      </Card>
      <UserDialog
        user={editing}
        roles={roles.data?.items ?? []}
        onClose={() => setEditing(null)}
        onDone={refresh}
      />
      <RoleDialog role={roleEditing} onClose={() => setRoleEditing(null)} onDone={refresh} />
    </div>
  );
}

function UserDialog({
  user,
  roles,
  onClose,
  onDone,
}: {
  user: UserRow | 'new' | null;
  roles: RoleRow[];
  onClose: () => void;
  onDone: () => void;
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
  const [error, setError] = useState('');
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const key = isNew ? 'new' : (u?.id ?? null);
  if (user && loadedFor !== key) {
    setLoadedFor(key);
    setError('');
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
        });
      } else {
        await api.patch(`/api/users/${u!.id}`, {
          fullName: f.fullName,
          active: f.active,
          roleIds: f.roleIds,
          commissionRate: f.commissionRate || null,
        });
      }
      toast.success('User saved.');
      onDone();
      onClose();
      setLoadedFor(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open={Boolean(user)}
      onOpenChange={(o) => (!o ? (onClose(), setLoadedFor(null)) : undefined)}
      title={isNew ? 'New user' : `Edit ${u?.fullName ?? ''}`}
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
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
            value={f.commissionRate}
            onChange={(e) => setF({ ...f, commissionRate: e.target.value })}
          />
        </Field>
        <div>
          <div className="mb-1.5 text-sm font-medium">Roles</div>
          <div className="flex flex-col gap-1.5">
            {roles.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={f.roleIds.includes(r.id)}
                  onChange={(e) =>
                    setF({
                      ...f,
                      roleIds: e.target.checked
                        ? [...f.roleIds, r.id]
                        : f.roleIds.filter((x) => x !== r.id),
                    })
                  }
                />
                {BUILT_IN_ROLE_LABELS[r.code as keyof typeof BUILT_IN_ROLE_LABELS] ?? r.name}
              </label>
            ))}
          </div>
        </div>
        {!isNew ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={f.active}
              onChange={(e) => setF({ ...f, active: e.target.checked })}
            />{' '}
            Active
          </label>
        ) : null}
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="flex items-center justify-between gap-2">
          <div>
            {!isNew &&
            u &&
            !u.roles.some(
              (r) =>
                r.code === 'SUPER_ADMIN' ||
                r.name.toLowerCase() === 'super admin' ||
                r.name.toLowerCase() === 'super_admin',
            ) ? (
              <Button
                type="button"
                variant="ghost"
                className="text-danger hover:bg-danger/10 hover:text-danger"
                onClick={async () => {
                  if (
                    !window.confirm(
                      `Are you sure you want to delete user "${u.fullName}" (${u.username})?`,
                    )
                  ) {
                    return;
                  }
                  try {
                    await api.delete(`/api/users/${u.id}`);
                    toast.success(`User "${u.fullName}" deleted.`);
                    onDone();
                    onClose();
                  } catch (err) {
                    setError(errorMessage(err));
                  }
                }}
              >
                Delete user
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

/** A role from module permissions: view, create, edit, approve, export per screen. */
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
  const allowed = new Set<string>(assignablePermissions());
  const modules = (Object.entries(MODULES) as [ModuleKey, (typeof MODULES)[ModuleKey]][]).filter(
    ([k]) => MODULES[k].actions.some((a) => allowed.has(`${k}.${a}`)),
  );
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      if (r) await api.patch(`/api/roles/${r.id}`, { name, permissions: [...perms] });
      else await api.post('/api/roles', { name, permissions: [...perms] });
      toast.success('Role saved.');
      onDone();
      onClose();
      setLoaded(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const toggle = (p: string) =>
    setPerms((s) => (s.has(p) ? new Set([...s].filter((x) => x !== p)) : new Set([...s, p])));
  return (
    <Dialog
      open={Boolean(role)}
      onOpenChange={(o) => (!o ? (onClose(), setLoaded(null)) : undefined)}
      title={r ? `Edit ${r.name}` : 'New role'}
      className="max-w-3xl"
    >
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <table className="w-full text-sm">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1 font-medium">Screen</th>
              {(['view', 'create', 'edit', 'approve', 'export'] as const).map((a) => (
                <th key={a} className="text-center font-medium">
                  {a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modules.map(([k, def]) => (
              <tr key={k} className="border-t border-border">
                <td className="py-1.5">{def.label}</td>
                {(['view', 'create', 'edit', 'approve', 'export'] as const).map((a) => (
                  <td key={a} className="text-center">
                    {(def.actions as readonly string[]).includes(a) ? (
                      <Checkbox
                        aria-label={`${def.label} ${a}`}
                        checked={perms.has(`${k}.${a}`)}
                        onChange={() => toggle(`${k}.${a}`)}
                      />
                    ) : null}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-border">
              <td className="py-1.5">{SPECIAL_PERMISSIONS['cost.item'].label}</td>
              <td className="text-center">
                <Checkbox checked={perms.has('cost.item')} onChange={() => toggle('cost.item')} />
              </td>
            </tr>
          </tbody>
        </table>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
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
