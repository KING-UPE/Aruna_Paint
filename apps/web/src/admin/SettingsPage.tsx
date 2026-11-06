import type { AppearanceSettings } from '@aruna/shared';
import { DatabaseBackup } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select, Textarea } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/auth/AuthProvider';
import { AppearanceCard } from './AppearanceCard';
import { TestModeCard } from './TestModeCard';
import { UpdatesCard } from './UpdatesCard';

type Settings = Record<string, Record<string, unknown>>;

/** Colour theme, shop details, receipt header and footer, billing rules, month start, alerts, backups, cloud link. */
export function SettingsPage() {
  const { me, can } = useAuth();
  const online = me.mode === 'cloud';
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
  const backupNow = async () => {
    try {
      const r = await api.post<{ requested?: boolean; status?: string; error?: string }>(
        '/api/backups',
        {},
      );
      if (r.requested)
        toast.success(
          'Asked. The shop makes the backup when it next connects; Cloud sync shows how it went.',
        );
      else if (r.status === 'OK') toast.success('Backup made.');
      else toast.error(`The backup failed: ${r.error ?? ''}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const section = (
    group: string,
    title: string,
    children: React.ReactNode,
    extra?: React.ReactNode,
  ) => (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <div className="flex shrink-0 gap-2">
          {extra}
          <Button size="sm" variant="primary" onClick={() => void save(group)}>
            Save
          </Button>
        </div>
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
      {me.roles.includes('SUPER_ADMIN') ? <TestModeCard /> : null}
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
        <Field
          key="screenLock"
          label="Screen lock"
          hint="On: an idle screen locks and asks for a PIN. Off: screens never time out and no PIN is asked. Every PC and the online panel."
        >
          <Select
            value={draft.billing?.screenLock === false ? 'off' : 'on'}
            onChange={(e) => set('billing', 'screenLock', e.target.value === 'on')}
          >
            <option value="on">On: ask for a PIN after the idle time</option>
            <option value="off">Off: no timeout, no PIN</option>
          </Select>
        </Field>,
        ...(draft.billing?.screenLock === false
          ? []
          : [number('billing', 'idleLockMinutes', 'Lock the screen after (minutes idle)')]),
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
        number('alerts', 'syncWaitingMinutes', 'Sync waiting too long (minutes)'),
        number('alerts', 'clockSkewMinutes', 'PC clock warning (minutes)'),
      ])}
      {online ? (
        <p className="text-sm text-muted">
          Changes saved here reach the shop when it next connects. The shop&apos;s link to the cloud
          is set at the shop.
        </p>
      ) : null}
      {section(
        'backup',
        'Backups',
        [
          text(
            'backup',
            'folder',
            'Backup folder',
            "On the shop's server PC. Empty uses the server data folder.",
          ),
          text('backup', 'secondFolder', 'Second copy (USB or second drive)'),
          text('backup', 'nightlyAt', 'Nightly backup time (HH:MM)'),
          number('backup', 'keepDaily', 'Daily copies to keep'),
          number('backup', 'keepMonthly', 'Monthly copies to keep'),
        ],
        can('backups.create') ? (
          <Button size="sm" icon={<DatabaseBackup size={15} />} onClick={() => void backupNow()}>
            Back up now
          </Button>
        ) : null,
      )}
      {!online && me.roles.includes('SUPER_ADMIN') ? (
        <UpdatesCard
          settingsFields={[
            <Field
              key="auto"
              label="Install new versions"
              hint="A backup is made first; the old version comes back by itself if anything fails."
            >
              <Select
                value={draft.updates?.auto === false ? 'off' : 'on'}
                onChange={(e) => set('updates', 'auto', e.target.value === 'on')}
              >
                <option value="on">By themselves, at the install time</option>
                <option value="off">Only when I press Install</option>
              </Select>
            </Field>,
            <div key="at" className="flex items-end gap-2">
              <div className="flex-1">
                {text('updates', 'installAt', 'Install time (HH:MM)', 'When nobody is billing.')}
              </div>
              <Button
                size="sm"
                variant="primary"
                className="mb-6"
                onClick={() => void save('updates')}
              >
                Save
              </Button>
            </div>,
          ]}
        />
      ) : null}
      {!online &&
        section('cloud', 'Cloud mirror', [
          text('cloud', 'url', 'Cloud address'),
          text('cloud', 'shopKey', 'Shop key'),
        ])}
      <NumberFormats />
      {section('printer', 'Receipt printer', [
        <Field
          key="driver"
          label="Printer"
          hint="Every PC prints receipts and day end reports on this one printer."
        >
          <Select
            value={String(draft.printer?.driver ?? 'none')}
            onChange={(e) => set('printer', 'driver', e.target.value)}
          >
            <option value="none">None</option>
            <option value="network">Network printer (port 9100)</option>
            <option value="windows-share">Shared Windows printer</option>
            <option value="file">File (testing)</option>
          </Select>
        </Field>,
        ...(draft.printer?.driver === 'network'
          ? [
              text('printer', 'host', 'Printer address', 'Such as 192.168.1.50.'),
              number('printer', 'port', 'Port', '9100 for most thermal printers.'),
            ]
          : draft.printer?.driver === 'windows-share'
            ? [text('printer', 'share', 'Share name', "The printer's share name on the server PC.")]
            : draft.printer?.driver === 'file'
              ? [text('printer', 'path', 'Folder', 'Empty uses the server data folder.')]
              : []),
      ])}
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
          {'{NNNN}'} number · {'{YYYY} {MM} {DD}'} date · {'{LOC}'}; letters allowed
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
