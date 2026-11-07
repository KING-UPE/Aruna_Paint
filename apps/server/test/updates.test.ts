import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newerVersion, UPDATER_TASK, UpdateService, type Fetch } from '../src/core/updates';
import { createTestApp, setupShop, testConfig, type Shop } from './helpers';

let app: FastifyInstance;
let shop: Shop;
let original: UpdateService;
const dataDir = '/tmp/aruna-test-updates';

beforeAll(async () => {
  app = await createTestApp();
  original = app.deps.updates;
});
afterAll(async () => {
  await app.close();
});

const INSTALLER = Buffer.from('pretend this is ArunaPOS-Setup-1.1.0.exe');
const SHA = createHash('sha256').update(INSTALLER).digest('hex');

/** GitHub's latest release with latest.json and the installer, as the release workflow makes. */
function fakeGitHub(opts: { version?: string; sha?: string; body?: Buffer } = {}) {
  const calls: string[] = [];
  const f: Fetch = async (url, init) => {
    calls.push(url);
    const sent = (init?.headers as Record<string, string> | undefined)?.['If-None-Match'];
    if (url.endsWith('/releases/latest') && sent === '"v1"')
      return new Response(null, { status: 304 });
    if (url.endsWith('/releases/latest'))
      return Response.json(
        {
          body: 'What is new',
          published_at: '2026-11-06T00:00:00Z',
          assets: [
            { name: 'latest.json', browser_download_url: 'https://dl/latest.json' },
            { name: 'ArunaPOS-Setup-1.1.0.exe', browser_download_url: 'https://dl/setup.exe' },
          ],
        },
        { headers: { etag: '"v1"' } },
      );
    if (url === 'https://dl/latest.json')
      return Response.json({
        version: opts.version ?? '1.1.0',
        file: 'ArunaPOS-Setup-1.1.0.exe',
        sha256: opts.sha ?? SHA,
        size: INSTALLER.length,
      });
    if (url === 'https://dl/setup.exe') return new Response(opts.body ?? INSTALLER);
    return new Response('not found', { status: 404 });
  };
  return { f, calls };
}

function service(fetchImpl: Fetch, ran: string[], installed = true, onReady = () => {}) {
  return new UpdateService(
    app.deps.db,
    { ...testConfig, dataDir, installDir: installed ? 'C:\\Program Files\\Aruna POS' : '' },
    app.deps.settings,
    '1.0.0',
    fetchImpl,
    async (name) => {
      ran.push(name);
    },
    'win32',
    onReady,
  );
}

beforeEach(async () => {
  shop = await setupShop(app);
  app.deps.updates = original;
  await rm(dataDir, { recursive: true, force: true });
});

describe('software updates', () => {
  it('checks every 15 minutes; an unchanged release costs one cheap 304', async () => {
    const { CHECK_EVERY_MS } = await import('../src/core/updates');
    expect(CHECK_EVERY_MS).toBe(15 * 60_000);
    const gh = fakeGitHub();
    const svc = service(gh.f, []);
    await svc.checkAndDownload();
    const first = gh.calls.length;
    const again = await svc.checkAndDownload();
    // Only the API call again (answered 304): no manifest or installer download.
    expect(gh.calls.slice(first)).toEqual([
      'https://api.github.com/repos/KING-UPE/Aruna_Paint/releases/latest',
    ]);
    expect(again).toMatchObject({ available: true, state: 'ready' });
    expect(again.latest?.version).toBe('1.1.0');
  });

  it('compares versions number by number', () => {
    expect(newerVersion('1.0.10', '1.0.9')).toBe(true);
    expect(newerVersion('v1.1.0', '1.0.9')).toBe(true);
    expect(newerVersion('1.0.0', '1.0.0')).toBe(false);
    expect(newerVersion('1.0.0', '1.0.1')).toBe(false);
  });

  it('finds a newer release, downloads it and installs through the updater task', async () => {
    const ran: string[] = [];
    const svc = service(fakeGitHub().f, ran);
    const status = await svc.checkAndDownload();
    expect(status).toMatchObject({ available: true, state: 'ready', error: null });
    expect(status.latest).toMatchObject({ version: '1.1.0', notes: 'What is new' });
    expect(await readFile(status.downloaded!)).toEqual(INSTALLER);

    // The Super Admin presses Install (through the route, which logs it).
    app.deps.updates = svc;
    const r = await shop.sa.post('/api/updates/install', {});
    expect(r.status).toBe(200);
    expect(ran).toEqual([UPDATER_TASK]);
    const pending = JSON.parse(await readFile(join(dataDir, 'updates', 'pending.json'), 'utf8'));
    expect(pending).toMatchObject({ version: '1.1.0', from: '1.0.0', sha256: SHA });
    const log = await app.deps.db.auditLog.findFirst({ where: { action: 'update.start' } });
    expect(log?.after).toEqual({ version: '1.1.0' });
  });

  it('throws away a download whose checksum does not match', async () => {
    const ran: string[] = [];
    const svc = service(fakeGitHub({ body: Buffer.from('tampered') }).f, ran);
    const status = await svc.checkAndDownload();
    expect(status.state).toBe('error');
    expect(status.error).toMatch(/damaged/);
    expect(status.downloaded).toBeNull();
    expect(existsSync(join(dataDir, 'updates', 'ArunaPOS-Setup-1.1.0.exe'))).toBe(false);
    await expect(svc.install()).rejects.toThrow();
    expect(ran).toEqual([]);
  });

  it('stays put when the release is not newer, and installs only on an installed server', async () => {
    const same = service(fakeGitHub({ version: '1.0.0' }).f, []);
    expect(await same.checkAndDownload()).toMatchObject({ available: false, downloaded: null });

    const dev = service(fakeGitHub().f, [], false);
    const status = await dev.checkAndDownload();
    expect(status).toMatchObject({ canInstall: false, available: true, downloaded: null });
    await expect(dev.install()).rejects.toThrow(/Windows installer/);
  });

  it('installs by itself at the set time, once a day, when switched on', async () => {
    const ran: string[] = [];
    const svc = service(fakeGitHub().f, ran);
    await svc.checkAndDownload();
    // 02:30 in Colombo is 21:00 UTC the day before.
    const at = new Date('2026-11-06T21:00:00Z');
    expect(await svc.autoInstall(new Date('2026-11-06T20:59:00Z'))).toBe(false);
    expect(await svc.autoInstall(at)).toBe(true);
    expect(await svc.autoInstall(at)).toBe(false);
    expect(ran).toEqual([UPDATER_TASK]);

    await shop.sa.put('/api/settings/updates', { auto: false, installAt: '02:30' });
    const off = service(fakeGitHub().f, []);
    await off.checkAndDownload();
    expect(await off.autoInstall(at)).toBe(false);
  });

  it("reports the installer's result once in the audit log, and alerts when it failed", async () => {
    await mkdir(join(dataDir, 'updates'), { recursive: true });
    // Written by Windows PowerShell 5.1: UTF-8 with a byte-order mark in front.
    await writeFile(
      join(dataDir, 'updates', 'last-result.json'),
      '\uFEFF' +
        JSON.stringify({
          version: '1.1.0',
          from: '1.0.0',
          ok: false,
          message: 'The server did not answer after the update.',
          at: '2026-11-06T21:05:00Z',
        }),
    );
    const svc = service(fakeGitHub().f, [], false);
    await svc.start();
    await svc.close();
    expect(svc.get().lastResult).toMatchObject({ version: '1.1.0', ok: false });
    expect(await app.deps.db.auditLog.count({ where: { action: 'update.failed' } })).toBe(1);
    const alert = await app.deps.db.alert.findFirst({ where: { kind: 'UPDATE_FAILED' } });
    expect(alert?.message).toMatch(/previous version was put back/);
    // Reported once: a second start only shows it.
    const again = service(fakeGitHub().f, [], false);
    await again.start();
    expect(again.get().lastResult?.version).toBe('1.1.0');
    expect(await app.deps.db.auditLog.count({ where: { action: 'update.failed' } })).toBe(1);
  });

  it('only the Super Admin and Admins see and start updates', async () => {
    expect((await shop.cashier.get('/api/updates')).status).toBe(403);
    expect((await shop.cashier.post('/api/updates/check', {})).status).toBe(403);
    expect((await shop.cashier.post('/api/updates/install', {})).status).toBe(403);
    expect((await shop.admin.get('/api/updates')).status).toBe(200);
    const r = await shop.sa.get('/api/updates');
    expect(r.body).toMatchObject({ current: expect.any(String), canInstall: false });
  });

  it('a finished download asks at once: the "update ready" pop-up, for those who install', async () => {
    let ready = 0;
    const svc = service(fakeGitHub().f, [], true, () => ready++);
    await svc.checkAndDownload();
    await svc.checkAndDownload(); // the same file again asks no second time
    expect(ready).toBe(1);
    app.deps.updates = svc;
    const forSa = (await shop.sa.get('/api/system/status')).body.update;
    expect(forSa).toMatchObject({ version: '1.1.0', choice: null, installAt: '02:30' });
    expect((await shop.admin.get('/api/system/status')).body.update.version).toBe('1.1.0');
    // A cashier at the counter is never interrupted by it.
    expect((await shop.cashier.get('/api/system/status')).body.update).toBeNull();
  });

  it('"Tonight" installs at the set time even with automatic installs off', async () => {
    await shop.sa.put('/api/settings/updates', { auto: false, installAt: '02:30' });
    const ran: string[] = [];
    const svc = service(fakeGitHub().f, ran);
    await svc.checkAndDownload();
    app.deps.updates = svc;
    const at = new Date('2026-11-06T21:00:00Z'); // 02:30 in Colombo
    expect(await svc.autoInstall(at)).toBe(false);
    const r = await shop.admin.post('/api/updates/choice', { when: 'night' });
    expect(r.status).toBe(200);
    expect(r.body.choice).toBe('night');
    expect((await shop.sa.get('/api/system/status')).body.update.choice).toBe('night');
    expect(await app.deps.db.auditLog.count({ where: { action: 'update.scheduled' } })).toBe(1);
    expect(await svc.autoInstall(new Date('2026-11-07T21:00:00Z'))).toBe(true);
    expect(ran).toEqual([UPDATER_TASK]);
  });

  it('"Next time the shop opens" installs at the next start, once', async () => {
    const svc = service(fakeGitHub().f, []);
    await svc.checkAndDownload();
    await svc.choose('startup');
    // The server restarts (the PC is switched on in the morning): a new service, same data.
    const ran: string[] = [];
    const next = service(fakeGitHub().f, ran);
    await next.start();
    await next.close();
    await expect.poll(() => ran.length).toBe(1);
    expect(ran).toEqual([UPDATER_TASK]);
    // Forgotten after one try, so a failed update isn't started again at every start.
    const again: string[] = [];
    const third = service(fakeGitHub().f, again);
    await third.start();
    await third.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(again).toEqual([]);
  });
});
