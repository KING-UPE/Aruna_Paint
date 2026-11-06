import { formatDateTime } from '@aruna/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useConfirm } from '@/components/AskDialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, CardTitle } from '@/components/ui/card';
import { api, errorMessage } from '@/lib/api';

interface UpdateStatus {
  current: string;
  canInstall: boolean;
  reason: string | null;
  latest: { version: string; notes: string; publishedAt: string | null } | null;
  available: boolean;
  checkedAt: string | null;
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';
  error: string | null;
  downloaded: string | null;
  lastResult: { version: string; ok: boolean; message: string; at: string } | null;
}

const STATE_WORDS: Record<UpdateStatus['state'], string> = {
  idle: '',
  checking: 'Checking…',
  downloading: 'Downloading…',
  ready: 'Downloaded, ready to install',
  installing: 'Installing: the server restarts in a minute or two',
  error: 'Problem',
};

/**
 * Super Admin, at the shop. The server checks the project's releases every 6 hours, downloads a
 * new version and installs it by itself at the set time (Settings → Software updates below), or
 * now with Install. The installer backs up first and puts the old version back if anything fails.
 */
export function UpdatesCard({ settingsFields }: { settingsFields: React.ReactNode }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const q = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.get<UpdateStatus>('/api/updates'),
    refetchInterval: (query) =>
      ['checking', 'downloading'].includes(query.state.data?.state ?? '') ? 3000 : false,
  });
  const s = q.data;

  const check = async () => {
    setBusy(true);
    try {
      const r = await api.post<UpdateStatus>('/api/updates/check', {});
      qc.setQueryData(['updates'], r);
      if (r.error) toast.error(r.error);
      else toast.success(r.available ? `Version ${r.latest?.version} is ready.` : 'Up to date.');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    const ok = await confirm({
      title: `Install version ${s?.latest?.version} now?`,
      message:
        'Billing stops for a minute or two on every PC while the server restarts. A backup is made first, and the old version comes back by itself if anything goes wrong.',
      confirmLabel: 'Install now',
    });
    if (!ok) return;
    try {
      const r = await api.post<UpdateStatus>('/api/updates/install', {});
      qc.setQueryData(['updates'], r);
      toast.success('Installing. The screens come back when the server has restarted.');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Software updates</CardTitle>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            icon={<RefreshCw size={15} />}
            disabled={busy || !s}
            onClick={() => void check()}
          >
            Check now
          </Button>
          {s?.canInstall && s.available && s.downloaded ? (
            <Button
              size="sm"
              variant="primary"
              icon={<Download size={15} />}
              disabled={s.state === 'installing'}
              onClick={() => void install()}
            >
              Install {s.latest?.version}
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardBody className="flex flex-col gap-3">
        {s ? (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>
                This server: <strong className="num">v{s.current}</strong>
              </span>
              {s.latest ? (
                <span className="text-muted">
                  · Newest: <span className="num">v{s.latest.version}</span>
                  {s.latest.publishedAt ? ` (${formatDateTime(s.latest.publishedAt)})` : ''}
                </span>
              ) : null}
              {s.latest && !s.available ? <Badge tone="ok">Up to date</Badge> : null}
              {s.available ? <Badge tone="accent">New version</Badge> : null}
              {STATE_WORDS[s.state] && s.state !== 'error' ? (
                <Badge tone="neutral">{STATE_WORDS[s.state]}</Badge>
              ) : null}
            </div>
            {s.checkedAt ? (
              <p className="text-sm text-muted">Last checked {formatDateTime(s.checkedAt)}.</p>
            ) : null}
            {s.error ? <p className="text-sm text-danger">{s.error}</p> : null}
            {s.reason ? <p className="text-sm text-muted">{s.reason}</p> : null}
            {s.lastResult ? (
              <p className={s.lastResult.ok ? 'text-sm text-ok' : 'text-sm text-danger'}>
                Last update ({formatDateTime(s.lastResult.at)}):{' '}
                {s.lastResult.ok
                  ? `version ${s.lastResult.version} installed.`
                  : `version ${s.lastResult.version} did not work, so the previous version was put back. ${s.lastResult.message}`}
              </p>
            ) : null}
            {s.available && s.latest?.notes ? (
              <details className="text-sm">
                <summary className="cursor-pointer text-accent-strong">What is new</summary>
                <p className="mt-1 whitespace-pre-wrap text-muted">{s.latest.notes}</p>
              </details>
            ) : null}
          </>
        ) : null}
        <div className="grid gap-3 md:grid-cols-2">{settingsFields}</div>
      </CardBody>
    </Card>
  );
}
