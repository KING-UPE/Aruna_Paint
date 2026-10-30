import type { AppearanceSettings } from '@aruna/shared';
import { Plus } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';
import { useValues } from '@/components/values';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import { AppearanceCard } from './AppearanceCard';
import { TestModeCard } from './TestModeCard';

type Settings = Record<string, Record<string, unknown>>;

/** Colour theme, shop details, receipt header and footer, billing rules, month start, alerts, backups, cloud link. */
export function SettingsPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const [draft, setDraft] = useState<Settings | null>(null);
  useEffect(() => {
    if (q.data) setDraft(structuredClone(q.data));
  }, [q.data]);
  if (!draft) return null;
  const set = (group: string, key: string, value: unknown) =>
    setDraft({ ...draft, [group]: { ...draft[group], [key]: value } });
  const save = async (group: string) => {
    try {
      await api.put(`/api/settings/${group}`, draft[group]);
      toast.success('Saved.');
      await qc.invalidateQueries({ queryKey: ['settings'] });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const text = (group: string, key: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input
        value={String(draft[group]?.[key] ?? '')}
        onChange={(e) => set(group, key, e.target.value)}
      />
    </Field>
  );
  const number = (group: string, key: string, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        value={String(draft[group]?.[key] ?? '')}
        onChange={(e) => set(group, key, Number(e.target.value))}
      />
    </Field>
  );
  const section = (group: string, title: string, children: React.ReactNode) => (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <Button size="sm" variant="primary" onClick={() => void save(group)}>
          Save
        </Button>
      </CardHeader>
      <CardBody className="grid gap-3 md:grid-cols-2">{children}</CardBody>
    </Card>
  );
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Settings" />
      {draft.appearance && q.data?.appearance ? (
        <AppearanceCard saved={q.data.appearance as unknown as AppearanceSettings} />
      ) : null}
      {me.roles.includes('SUPER_ADMIN') && me.mode === 'shop' ? <TestModeCard /> : null}
      {section('shop', 'Shop', [
        text('shop', 'shopName', 'Shop name'),
        text('shop', 'address', 'Address'),
        text('shop', 'phone', 'Phone'),
      ])}
      {section('receipt', 'Receipt', [
        <Field
          key="lang"
          label="Receipt language"
          hint="Sinhala receipts print as an image (coming with the printer setup)."
        >
          <Select
            value={String(draft.receipt?.language)}
            onChange={(e) => set('receipt', 'language', e.target.value)}
          >
            <option value="en">English</option>
            <option value="si">Sinhala</option>
          </Select>
        </Field>,
        number('receipt', 'lineWidth', 'Characters per line', '48 for most 80 mm printers.'),
        <Field key="h" label="Header (English)">
          <Textarea
            value={String(draft.receipt?.headerEn ?? '')}
            onChange={(e) => set('receipt', 'headerEn', e.target.value)}
          />
        </Field>,
        <Field key="f" label="Footer (English)" hint="The return policy.">
          <Textarea
            value={String(draft.receipt?.footerEn ?? '')}
            onChange={(e) => set('receipt', 'footerEn', e.target.value)}
          />
        </Field>,
      ])}
      {section('billing', 'Billing', [
        number('billing', 'quotationValidityDays', 'Quotation validity (days)'),
        number('billing', 'idleLockMinutes', 'Lock the screen after (minutes idle)'),
        <Field key="round" label="Round the net total to">
          <Select
            value={String(draft.billing?.netTotalRounding)}
            onChange={(e) => set('billing', 'netTotalRounding', e.target.value)}
          >
            <option value="0.01">No rounding</option>
            <option value="1">Rs 1</option>
            <option value="5">Rs 5</option>
            <option value="10">Rs 10</option>
          </Select>
        </Field>,
        <Field key="tf" label="Time format">
          <Select
            value={String(draft.billing?.timeFormat)}
            onChange={(e) => set('billing', 'timeFormat', e.target.value)}
          >
            <option value="24h">24-hour</option>
            <option value="12h">12-hour</option>
          </Select>
        </Field>,
      ])}
      {section('closing', 'Monthly closing', [
        number(
          'closing',
          'monthStartDay',
          'Month starts on day',
          'The 1st by default, or any day such as the 25th.',
        ),
      ])}
      {section('alerts', 'Alert limits', [
        number('alerts', 'nearExpiryDays', 'Near expiry (days)'),
        number('alerts', 'cashDifferenceLimit', 'Cash difference at day end (Rs)'),
        number('alerts', 'syncWaitingMinutes', 'Sync waiting too long (minutes)'),
        number('alerts', 'clockSkewMinutes', 'PC clock warning (minutes)'),
      ])}
      {/* Backups, the cloud link and the counters' printers belong to the shop's own PCs. */}
      {me.mode === 'cloud' ? (
        <p className="text-sm text-muted">
          Backups, the cloud link and the counters are set at the shop. Changes saved here reach the
          shop when it next connects.
        </p>
      ) : null}
      {me.mode === 'shop' &&
        section('backup', 'Backups', [
          text('backup', 'folder', 'Backup folder', 'Empty uses the server data folder.'),
          text('backup', 'secondFolder', 'Second copy (USB or second drive)'),
          text('backup', 'nightlyAt', 'Nightly backup time (HH:MM)'),
          number('backup', 'keepDaily', 'Daily copies to keep'),
          number('backup', 'keepMonthly', 'Monthly copies to keep'),
        ])}
      {me.mode === 'shop' &&
        section('cloud', 'Cloud mirror', [
          text('cloud', 'url', 'Cloud address'),
          text('cloud', 'shopKey', 'Shop key'),
        ])}
      <NumberFormats />
      {me.mode === 'shop' ? <Counters /> : null}
    </div>
  );
}

function NumberFormats() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['number-formats'],
    queryFn: () =>
      api.get<{ items: { docType: string; label: string; format: string; example: string }[] }>(
        '/api/number-formats',
      ),
  });
  const [edits, setEdits] = useState<Record<string, string>>({});
  return (
    <Card>
      <CardHeader>
        <CardTitle>Number formats</CardTitle>
        <span className="text-sm text-muted">
          {'{NNNN}'} number · {'{YYYY} {MM} {DD}'} date · {'{COUNTER}'} · {'{LOC}'}; letters allowed
        </span>
      </CardHeader>
      <CardBody className="grid gap-2 md:grid-cols-2">
        {(q.data?.items ?? []).map((f) => (
          <form
            key={f.docType}
            className="flex items-end gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.put(`/api/number-formats/${f.docType}`, {
                  format: edits[f.docType] ?? f.format,
                });
                toast.success(`${f.label} format saved.`);
                await qc.invalidateQueries({ queryKey: ['number-formats'] });
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          >
            <Field label={f.label} hint={`Next looks like ${f.example}`} className="flex-1">
              <Input
                value={edits[f.docType] ?? f.format}
                onChange={(e) => setEdits({ ...edits, [f.docType]: e.target.value })}
              />
            </Field>
            <Button type="submit" size="sm" className="mb-6">
              Save
            </Button>
          </form>
        ))}
      </CardBody>
    </Card>
  );
}

interface CounterRow {
  id: string;
  code: string;
  name: string;
  locationId: string;
  active: boolean;
  printer: { driver: string; host?: string; port?: number; path?: string; share?: string };
}

/** Billing PCs and their 80 mm printers. */
function Counters() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['counters'],
    queryFn: () => api.get<{ items: CounterRow[] }>('/api/counters'),
  });
  const locations = useValues('locations');
  const save = async (c: CounterRow) => {
    try {
      const printer =
        c.printer.driver === 'network'
          ? { driver: 'network', host: c.printer.host ?? '', port: Number(c.printer.port ?? 9100) }
          : c.printer.driver === 'windows-share'
            ? { driver: 'windows-share', share: c.printer.share ?? '' }
            : c.printer.driver === 'file'
              ? { driver: 'file', path: c.printer.path ?? '' }
              : { driver: 'none' };
      if (c.id)
        await api.patch(`/api/counters/${c.id}`, {
          code: c.code,
          name: c.name,
          locationId: c.locationId,
          active: c.active,
          printer,
        });
      else
        await api.post('/api/counters', {
          code: c.code,
          name: c.name,
          locationId: c.locationId,
          printer,
        });
      toast.success(`${c.name} saved.`);
      await qc.invalidateQueries({ queryKey: ['counters'] });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const [rows, setRows] = useState<CounterRow[] | null>(null);
  useEffect(() => {
    if (q.data)
      setRows(q.data.items.map((c) => ({ ...c, printer: c.printer ?? { driver: 'none' } })));
  }, [q.data]);
  const upd = (i: number, patch: Partial<CounterRow>) =>
    setRows((r) => r!.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Counters and printers</CardTitle>
        <Button
          size="sm"
          icon={<Plus size={16} />}
          onClick={() =>
            setRows([
              ...(rows ?? []),
              {
                id: '',
                code: `C${(rows?.length ?? 0) + 1}`,
                name: `Counter ${(rows?.length ?? 0) + 1}`,
                locationId: locations.data?.items[0]?.id ?? '',
                active: true,
                printer: { driver: 'none' },
              },
            ])
          }
        >
          + Counter
        </Button>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Open the POS on a billing PC as http://server:3000/?counter=C1 so it remembers its
          counter.
        </p>
        {(rows ?? []).map((c, i) => (
          <div
            key={c.id || i}
            className="grid items-end gap-2 md:grid-cols-[80px_1fr_160px_160px_1fr_auto]"
          >
            <Field label="Code">
              <Input value={c.code} onChange={(e) => upd(i, { code: e.target.value })} />
            </Field>
            <Field label="Name">
              <Input value={c.name} onChange={(e) => upd(i, { name: e.target.value })} />
            </Field>
            <Field label="Location">
              <Select value={c.locationId} onChange={(e) => upd(i, { locationId: e.target.value })}>
                {(locations.data?.items ?? [])
                  .filter((l) => l.kind !== 'DAMAGED')
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label="Printer">
              <Select
                value={c.printer.driver}
                onChange={(e) => upd(i, { printer: { ...c.printer, driver: e.target.value } })}
              >
                <option value="none">None</option>
                <option value="network">Network (port 9100)</option>
                <option value="windows-share">Shared Windows printer</option>
                <option value="file">File (testing)</option>
              </Select>
            </Field>
            <Field
              label={
                c.printer.driver === 'network'
                  ? 'Printer address'
                  : c.printer.driver === 'windows-share'
                    ? 'Share name'
                    : c.printer.driver === 'file'
                      ? 'Folder'
                      : ' '
              }
            >
              <Input
                disabled={c.printer.driver === 'none'}
                value={
                  c.printer.driver === 'network'
                    ? (c.printer.host ?? '')
                    : c.printer.driver === 'windows-share'
                      ? (c.printer.share ?? '')
                      : (c.printer.path ?? '')
                }
                onChange={(e) =>
                  upd(i, {
                    printer:
                      c.printer.driver === 'network'
                        ? { ...c.printer, host: e.target.value }
                        : c.printer.driver === 'windows-share'
                          ? { ...c.printer, share: e.target.value }
                          : { ...c.printer, path: e.target.value },
                  })
                }
              />
            </Field>
            <Button className="mb-0" onClick={() => void save(c)}>
              Save
            </Button>
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
