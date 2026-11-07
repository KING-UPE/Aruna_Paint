import { randomUUID } from 'node:crypto';
import type { Db } from '../db';
import { SHOP_REQUESTS } from '../modules/sync/online';
import type { ActorRef } from './context';
import type { SettingsService } from './settings';
import {
  findConflicts,
  mergeChange,
  realRow,
  TableCatalog,
  type Conflict,
  type RowChange,
} from './syncapply';

/** How the shop talks to the cloud; tests pass the cloud app's inject instead of fetch. */
export type SyncTransport = (
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  auth: { url: string; key: string; node: string },
) => Promise<{ status: number; body: unknown }>;

export const fetchTransport: SyncTransport = async (method, path, body, auth) => {
  const res = await fetch(`${auth.url.replace(/\/+$/, '')}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${auth.key}`,
      'x-sync-node': auth.node,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  // The panel always answers JSON. Anything else is another site: most often a Vercel address
  // behind Vercel's own sign-in (a per-deployment address) or a mistyped one.
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? "That address asks for a Vercel sign-in, so it isn't the online panel's public address. Use the panel's main address, like https://arunapaint.vercel.app."
        : res.status === 404
          ? 'Nothing answers at that address. Check the online panel address.'
          : `That address doesn't answer like the online panel (HTTP ${res.status}). Check the online panel address.`,
    );
  }
  return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
};

interface CloudCommand {
  id: string;
  createdAt: string;
  createdById: string | null;
  createdByName: string;
  route: string;
  summary: string;
  changes: RowChange[];
  status: string;
  decision: 'APPLY' | 'DISCARD' | null;
  decidedByName: string;
}

export interface SyncStatus {
  linked: boolean;
  url: string;
  /** The last try reached the cloud. */
  online: boolean;
  lastSyncAt: string | null;
  lastTryAt: string | null;
  lastError: string;
  waiting: number;
  /**
   * False when the online panel uses another PIN secret and this shop already had PINs of its
   * own, so PINs set online don't work here. Null until the cloud answered.
   */
  pinSecretShared: boolean | null;
}

const FINAL = new Set(['APPLIED', 'DISCARDED', 'FAILED']);
/** sync_state key: a full copy of the shop is queued (or gone up). Deleting it sends another. */
export const FULL_COPY_DONE = 'full_copy';
const PUSH_BATCH = 500;

function plainError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/unique constraint|duplicate key|23505|already exists/i.test(msg))
    return 'It clashes with something already at the shop (the same name, code or PIN).';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|timeout|aborted/i.test(msg))
    return 'The cloud could not be reached (no internet, or a wrong cloud address).';
  return msg.split('\n').filter(Boolean).pop()!.slice(0, 300);
}

/**
 * The shop's sync agent. Every 15 s while the internet is up: take the changes made online,
 * check each field against what the shop changed meanwhile, apply them or hold them as a
 * conflict for the Super Admin; then send the shop's own changes up. Billing never waits for it.
 */
export class SyncAgent {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SyncStatus> | null = null;
  private catalog = new TableCatalog();
  private state = {
    online: false,
    lastSyncAt: null as string | null,
    lastTryAt: null as string | null,
    lastError: '',
    pinSecretShared: null as boolean | null,
  };

  constructor(
    /** Always the real database, never a test-mode copy. */
    private readonly db: Db,
    private readonly settings: SettingsService,
    private readonly version: string,
    private readonly hooks: {
      /** After online changes were applied: caches and screens refresh. */
      onApplied: (changes: RowChange[]) => void;
      /** Does a request made online (SHOP_REQUESTS); the answer is shown on the panel. */
      runRequest: (route: string, by: ActorRef) => Promise<string>;
      /** The panel's PIN secret: false when the shop keeps its own (it already has PINs). */
      pinSecret?: (secret: string) => Promise<boolean>;
    },
    private readonly transport: SyncTransport = fetchTransport,
  ) {}

  start() {
    this.timer = setInterval(() => void this.sync().catch(() => undefined), 15_000);
    this.timer.unref();
    void this.sync().catch(() => undefined);
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    return this.running?.catch(() => undefined);
  }

  /** One round now (or join the one running). */
  sync(): Promise<SyncStatus> {
    if (!this.running)
      this.running = this.round().finally(() => {
        this.running = null;
      });
    return this.running;
  }

  async status(): Promise<SyncStatus> {
    const cfg = await this.settings.get('cloud');
    const waiting = await this.db.syncOutbox.count({ where: { sentAt: null } });
    return {
      linked: Boolean(cfg.url && cfg.shopKey),
      url: cfg.url,
      online: this.state.online,
      lastSyncAt: this.state.lastSyncAt ?? (await this.saved())?.lastSyncAt ?? null,
      lastTryAt: this.state.lastTryAt,
      lastError: this.state.lastError,
      waiting,
      pinSecretShared: this.state.pinSecretShared,
    };
  }

  private async saved() {
    const row = await this.db.syncState.findUnique({ where: { key: 'agent' } });
    return row?.value as { lastSyncAt?: string } | undefined;
  }

  /** This server's id at the cloud, made once. */
  private async node() {
    const row = await this.db.syncState.findUnique({ where: { key: 'node' } });
    if (row) return (row.value as { id: string }).id;
    const id = randomUUID();
    await this.db.syncState.create({ data: { key: 'node', value: { id } } });
    return id;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const cfg = await this.settings.get('cloud');
    const res = await this.transport(method, path, body, {
      url: cfg.url,
      key: cfg.shopKey,
      node: await this.node(),
    });
    if (res.status >= 400) {
      const e = (res.body as { error?: { message?: string } } | null)?.error;
      throw new Error(e?.message ?? `The cloud answered ${res.status}.`);
    }
    return res.body;
  }

  private async round(): Promise<SyncStatus> {
    const cfg = await this.settings.get('cloud');
    if (!cfg.url || !cfg.shopKey) return this.status();
    this.state.lastTryAt = new Date().toISOString();
    try {
      // Online changes first, so the shop's backlog sent after them already includes them.
      const { items, pinSecret } = (await this.call('GET', '/api/sync/commands')) as {
        items: CloudCommand[];
        pinSecret?: string;
      };
      // Before the online changes: the owner's account comes with a PIN made with that secret.
      if (pinSecret && this.hooks.pinSecret)
        this.state.pinSecretShared = await this.hooks.pinSecret(pinSecret);
      for (const c of items) await this.take(c);
      await this.fullCopyIfNeeded();
      await this.push();
      this.state.online = true;
      this.state.lastError = '';
      this.state.lastSyncAt = new Date().toISOString();
      await this.db.syncState.upsert({
        where: { key: 'agent' },
        create: { key: 'agent', value: { lastSyncAt: this.state.lastSyncAt } },
        update: { value: { lastSyncAt: this.state.lastSyncAt } },
      });
    } catch (err) {
      this.state.online = false;
      this.state.lastError = plainError(err);
    }
    return this.status();
  }

  private async push() {
    const shop = await this.settings.get('shop');
    const last = await this.db.sale.aggregate({
      where: { status: 'COMPLETED' },
      _max: { completedAt: true },
    });
    const info = {
      name: shop.shopName,
      version: this.version,
      lastBillAt: last._max.completedAt?.toISOString() ?? null,
    };
    for (let round = 0; round < 40; round++) {
      const rows = await this.db.syncOutbox.findMany({
        where: { sentAt: null },
        orderBy: { id: 'asc' },
        take: PUSH_BATCH,
      });
      const waiting = await this.db.syncOutbox.count({ where: { sentAt: null } });
      const res = (await this.call('POST', '/api/sync/push', {
        ...info,
        waiting,
        changes: rows.map((r) => ({
          id: r.id.toString(),
          table: r.tableName,
          op: r.op,
          pk: r.pk,
          data: r.data,
          old: r.old,
        })),
      })) as { lastChangeId: string; needFullCopy?: boolean };
      if (rows.length)
        await this.db.syncOutbox.updateMany({
          where: { id: { lte: BigInt(res.lastChangeId) }, sentAt: null },
          data: { sentAt: new Date() },
        });
      if (res.needFullCopy) {
        // The cloud has no full copy of this shop: the next round sends one.
        await this.db.syncState.deleteMany({ where: { key: FULL_COPY_DONE } });
        return;
      }
      if (!rows.length) return;
      if (rows.length < PUSH_BATCH) return;
    }
  }

  /**
   * A full copy of the shop goes up once, before anything else, when the cloud has none: the first
   * link, a copy the cloud lost or started again, or after the shop's data was cleaned. Without
   * it the cloud would only see rows changed since, and miss things like the roles.
   */
  private async fullCopyIfNeeded() {
    if (await this.db.syncState.findUnique({ where: { key: FULL_COPY_DONE } })) return;
    await this.db.$transaction(
      async (tx) => {
        const [r] = await tx.$queryRaw<{ rows: number }[]>`SELECT sync_full_copy() AS rows`;
        const value = { at: new Date().toISOString(), rows: r?.rows ?? 0 };
        await tx.syncState.upsert({
          where: { key: FULL_COPY_DONE },
          create: { key: FULL_COPY_DONE, value },
          update: { value },
        });
      },
      { maxWait: 30_000, timeout: 600_000 },
    );
  }

  /** One online change: apply, or hold as a conflict, or follow the Super Admin's answer. */
  private async take(c: CloudCommand) {
    const local = await this.db.syncCommand.findUnique({ where: { id: c.id } });
    if (local && FINAL.has(local.status)) return this.report(local.id);
    if (local?.status === 'CONFLICT' && !c.decision && !local.decision) return;
    await this.process(c, c.decision ?? (local?.decision as CloudCommand['decision']) ?? null, {
      name: c.decidedByName,
    });
    await this.report(c.id);
  }

  /** Also used when the Super Admin answers a conflict at the shop itself. */
  async process(
    c: CloudCommand,
    decision: CloudCommand['decision'],
    by: { id?: string; name: string },
  ) {
    const base = {
      id: c.id,
      createdAt: new Date(c.createdAt),
      createdById: c.createdById,
      createdByName: c.createdByName,
      route: c.route,
      summary: c.summary,
      changes: c.changes as unknown as object,
    };
    let status = 'APPLIED';
    let message = '';
    let conflicts: Conflict[] = [];
    if (decision === 'DISCARD') {
      status = 'DISCARDED';
      message = 'The shop version was kept.';
    } else {
      try {
        await this.db.$transaction(
          async (tx) => {
            if (decision !== 'APPLY') conflicts = await findConflicts(tx, this.catalog, c.changes);
            if (conflicts.length) return;
            for (const ch of c.changes) await mergeChange(tx, this.catalog, ch);
          },
          { maxWait: 10_000, timeout: 60_000 },
        );
        if (conflicts.length) {
          status = 'CONFLICT';
          message = 'Changed at the shop too while offline. The Super Admin decides which to keep.';
        } else if (SHOP_REQUESTS[c.route])
          message = await this.hooks.runRequest(c.route, { userId: c.createdById });
        else if (decision === 'APPLY')
          message = 'The online change was applied over the shop version.';
      } catch (err) {
        status = 'FAILED';
        message = plainError(err);
      }
    }
    const data = {
      status,
      message,
      conflicts: conflicts.length ? (conflicts as unknown as object) : undefined,
      decision: decision ?? null,
      decidedByName: decision ? by.name : '',
      decidedById: decision ? (by.id ?? null) : null,
      decidedAt: decision ? new Date() : null,
      processedAt: new Date(),
    };
    await this.db.syncCommand.upsert({
      where: { id: c.id },
      create: { ...base, ...data },
      update: data,
    });
    if (status === 'APPLIED' && c.changes.length) this.hooks.onApplied(c.changes);
  }

  /**
   * Tells the cloud what happened to an online change. When the shop didn't take it, the shop's
   * real rows go along (last change first, so rows made online go before their parents), and the
   * cloud puts them back before anything else arrives.
   */
  private async report(id: string) {
    const r = await this.db.syncCommand.findUniqueOrThrow({ where: { id } });
    const changes = r.changes as unknown as RowChange[];
    const undo =
      r.status === 'FAILED' || r.status === 'DISCARDED'
        ? await this.db.$transaction(async (tx) => {
            const out: RowChange[] = [];
            for (const ch of [...changes].reverse()) out.push(await realRow(tx, this.catalog, ch));
            return out;
          })
        : [];
    await this.call('POST', `/api/sync/commands/${id}/result`, {
      undo,
      status: r.status,
      message: r.message,
      conflicts: r.conflicts,
      decision: r.decision,
      decidedByName: r.decidedByName,
    });
  }
}
