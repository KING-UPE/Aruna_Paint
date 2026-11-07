import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import { audit } from './audit';
import type { SettingsService } from './settings';

/**
 * Software updates of the installed shop server (plan § "Automatic updates").
 *
 * - Every 15 minutes, at start and on "Check now" it reads the latest release of the project's GitHub
 *   repository. Each release carries the installer and `latest.json`
 *   (`{ version, file, sha256, size }`), written by `installer/build.mjs`.
 * - A newer version is downloaded to `<data>/updates` and kept only if its SHA-256 matches.
 * - At the set time (Settings → Software updates, `updates.installAt`), or when the Super Admin
 *   presses Install, it writes `pending.json` and starts the "Aruna POS Updater" scheduled task
 *   the installer registered. That task runs as SYSTEM outside this service, so it can stop the
 *   server: the installer backs up the database, replaces the program, takes the new migrations,
 *   starts the server and checks it answers, and puts the old version and data back if any step
 *   fails. It writes `last-result.json`, which the next start reports in the audit log.
 *
 * Only a server installed by the Windows installer installs updates (`ARUNA_INSTALL_DIR`).
 */

export const UPDATER_TASK = 'Aruna POS Updater';
/**
 * How often the shop looks for a new version. GitHub allows 60 unauthenticated API calls an hour
 * per internet connection; an unchanged answer (304, thanks to the ETag) doesn't count, so a few
 * shop PCs behind one connection stay far below it.
 */
export const CHECK_EVERY_MS = 15 * 60_000;

export interface ReleaseInfo {
  version: string;
  file: string;
  sha256: string;
  size: number;
  url: string;
  notes: string;
  publishedAt: string | null;
}

export interface UpdateStatus {
  current: string;
  /** False when this server can't install updates itself, with the reason. */
  canInstall: boolean;
  reason: string | null;
  latest: ReleaseInfo | null;
  available: boolean;
  checkedAt: string | null;
  state: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';
  error: string | null;
  downloaded: string | null;
  lastResult: UpdateResult | null;
  /**
   * What the person chose in the "update ready" pop-up for this version: install tonight at the
   * set time, or when the shop server next starts. Null: not chosen (the pop-up asks).
   */
  choice: UpdateChoice | null;
}

export type UpdateChoice = 'night' | 'startup';

export interface UpdateResult {
  version: string;
  from?: string;
  ok: boolean;
  message: string;
  at: string;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
/** Starts the updater task; replaced in tests. */
export type RunTask = (name: string) => Promise<void>;

/** "1.2.10" > "1.2.9"; anything after a "-" or "+" is ignored. */
export function newerVersion(a: string, b: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[-+]/)[0]!
      .split('.')
      .map((n) => Number(n) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

function shopClock(now: Date) {
  const hm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Colombo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(now);
  return { hm, day };
}

const runSchtasks: RunTask = (name) =>
  new Promise((resolve, reject) =>
    execFile('schtasks.exe', ['/Run', '/TN', name], { windowsHide: true }, (err, _out, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(),
    ),
  );

export class UpdateService {
  private status: UpdateStatus;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> | null = null;
  private lastAutoDay: string | null = null;
  /** The last answer about the newest release, with GitHub's ETag for cheap repeat checks. */
  private cached: { etag: string; release: ReleaseInfo } | null = null;
  private chosen: { version: string; when: UpdateChoice } | null = null;
  private readonly dir: string;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly settings: SettingsService,
    version: string,
    private readonly fetchImpl: Fetch = fetch,
    private readonly runTask: RunTask = runSchtasks,
    private readonly platform: NodeJS.Platform = process.platform,
    /** A new version finished downloading: the screens ask what to do (the pop-up). */
    private readonly onReady: () => void = () => {},
  ) {
    this.dir = join(config.dataDir, 'updates');
    const reason =
      config.mode !== 'shop'
        ? 'The online panel is updated where it is hosted.'
        : this.platform !== 'win32' || !config.installDir
          ? 'Automatic updates work on a shop server put in with the Windows installer.'
          : null;
    this.status = {
      current: version,
      canInstall: reason === null,
      reason,
      latest: null,
      available: false,
      checkedAt: null,
      state: 'idle',
      error: null,
      downloaded: null,
      lastResult: null,
      choice: null,
    };
  }

  get(): UpdateStatus {
    const latest = this.status.latest?.version;
    const choice = this.chosen && this.chosen.version === latest ? this.chosen.when : null;
    return { ...this.status, choice };
  }

  /** Reports how the last update went (once), then checks now and every 6 hours. */
  async start() {
    await this.reportLastResult();
    if (!this.status.canInstall) return;
    await this.loadChoice();
    void this.checkAndDownload()
      .then(() => this.installIfChosenAtStart())
      .catch(() => undefined);
    let lastCheck = Date.now();
    this.timer = setInterval(() => {
      void (async () => {
        if (Date.now() - lastCheck >= CHECK_EVERY_MS) {
          lastCheck = Date.now();
          await this.checkAndDownload().catch(() => undefined);
        }
        await this.autoInstall(new Date()).catch(() => undefined);
        // A successful update writes its result after this server started: report it now.
        await this.reportLastResult().catch(() => undefined);
      })();
    }, 60_000);
    this.timer.unref();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.busy?.catch(() => undefined);
  }

  /** Reads the newest release and, when it is newer than this server, downloads it. */
  async checkAndDownload(): Promise<UpdateStatus> {
    if (this.busy) {
      await this.busy.catch(() => undefined);
      return this.get();
    }
    const job = (async () => {
      this.status.state = 'checking';
      this.status.error = null;
      try {
        const latest = await this.latestRelease();
        this.status.latest = latest;
        this.status.checkedAt = new Date().toISOString();
        this.status.available = newerVersion(latest.version, this.status.current);
        const had = this.status.downloaded;
        if (this.status.available && this.status.canInstall) await this.download(latest);
        this.status.state = this.status.downloaded ? 'ready' : 'idle';
        if (this.status.downloaded && this.status.downloaded !== had) this.onReady();
      } catch (err) {
        this.status.state = 'error';
        this.status.error = err instanceof Error ? err.message : String(err);
      }
    })();
    this.busy = job;
    try {
      await job;
    } finally {
      this.busy = null;
    }
    return this.get();
  }

  private async latestRelease(): Promise<ReleaseInfo> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ArunaPOS-updater',
    };
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${this.config.updateRepo}/releases/latest`,
      { headers: this.cached ? { ...headers, 'If-None-Match': this.cached.etag } : headers },
    );
    // Nothing new since the last check (and it doesn't count against GitHub's limit).
    if (res.status === 304 && this.cached) return this.cached.release;
    if (res.status === 404) throw new Error('No release has been published yet.');
    if (!res.ok) throw new Error(`Could not reach the update server (HTTP ${res.status}).`);
    const release = (await res.json()) as {
      body?: string;
      published_at?: string;
      assets?: { name: string; browser_download_url: string }[];
    };
    const assets = release.assets ?? [];
    const manifest = assets.find((a) => a.name === 'latest.json');
    if (!manifest) throw new Error('The newest release has no latest.json.');
    const m = await this.fetchImpl(manifest.browser_download_url, { headers });
    if (!m.ok) throw new Error(`Could not read latest.json (HTTP ${m.status}).`);
    const info = (await m.json()) as {
      version?: string;
      file?: string;
      sha256?: string;
      size?: number;
    };
    if (!info.version || !info.file || !/^[a-f0-9]{64}$/.test(info.sha256 ?? ''))
      throw new Error('latest.json is not complete.');
    const asset = assets.find((a) => a.name === info.file);
    if (!asset) throw new Error(`The release is missing ${info.file}.`);
    const out: ReleaseInfo = {
      version: info.version,
      file: info.file,
      sha256: info.sha256!,
      size: info.size ?? 0,
      url: asset.browser_download_url,
      notes: release.body ?? '',
      publishedAt: release.published_at ?? null,
    };
    const etag = res.headers.get('etag');
    this.cached = etag ? { etag, release: out } : null;
    return out;
  }

  private async download(r: ReleaseInfo) {
    if (r.file.includes('/') || r.file.includes('\\')) throw new Error('Bad installer name.');
    await mkdir(this.dir, { recursive: true });
    const target = join(this.dir, r.file);
    if (existsSync(target) && (await sha256File(target)) === r.sha256) {
      this.status.downloaded = target;
      return;
    }
    this.status.state = 'downloading';
    const res = await this.fetchImpl(r.url, { headers: { 'User-Agent': 'ArunaPOS-updater' } });
    if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status}).`);
    const part = `${target}.part`;
    const hash = createHash('sha256');
    const body = Readable.fromWeb(res.body as never);
    body.on('data', (chunk: Buffer) => hash.update(chunk));
    await pipeline(body, createWriteStream(part));
    const got = hash.digest('hex');
    if (got !== r.sha256) {
      await unlink(part).catch(() => undefined);
      throw new Error(
        'The downloaded installer is damaged (its checksum does not match). It will be downloaded again.',
      );
    }
    await rename(part, target);
    // Older installers are not needed any more.
    for (const f of await readdir(this.dir))
      if (f.endsWith('.exe') && f !== r.file) await rm(join(this.dir, f), { force: true });
    this.status.downloaded = target;
  }

  /** Starts the updater task with the downloaded installer. The server stops soon after. */
  async install(): Promise<UpdateStatus> {
    if (!this.status.canInstall) throw new Error(this.status.reason ?? 'Updates are off here.');
    const latest = this.status.latest;
    if (!latest || !this.status.available) throw new Error('This server is up to date.');
    if (!this.status.downloaded) await this.checkAndDownload();
    if (!this.status.downloaded)
      throw new Error(this.status.error ?? 'The update is not downloaded yet.');
    // Checked again just before it runs: the file sits in the data folder for hours.
    if ((await sha256File(this.status.downloaded)) !== latest.sha256) {
      this.status.downloaded = null;
      throw new Error('The downloaded installer is damaged. Press Check now to fetch it again.');
    }
    await writeFile(
      join(this.dir, 'pending.json'),
      JSON.stringify({
        version: latest.version,
        from: this.status.current,
        installer: this.status.downloaded,
        sha256: latest.sha256,
        at: new Date().toISOString(),
      }),
    );
    await this.runTask(UPDATER_TASK);
    this.status.state = 'installing';
    return this.get();
  }

  /** The automatic install: once a day at the set time, when a newer version is downloaded. */
  async autoInstall(now: Date): Promise<boolean> {
    const cfg = await this.settings.get('updates');
    // "Tonight" in the pop-up installs at the set time even with automatic installs off.
    const tonight = this.get().choice === 'night';
    if ((!cfg.auto && !tonight) || !this.status.downloaded || !this.status.available) return false;
    const { hm, day } = shopClock(now);
    if (hm !== cfg.installAt || this.lastAutoDay === day) return false;
    this.lastAutoDay = day;
    await this.install();
    return true;
  }

  /** The pop-up's answer for the downloaded version: tonight, or when the server next starts. */
  async choose(when: UpdateChoice): Promise<UpdateStatus> {
    const version = this.status.latest?.version;
    if (!this.status.canInstall) throw new Error(this.status.reason ?? 'Updates are off here.');
    if (!version || !this.status.available || !this.status.downloaded)
      throw new Error('There is no update ready to install.');
    this.chosen = { version, when };
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, 'choice.json'), JSON.stringify(this.chosen));
    return this.get();
  }

  private async loadChoice() {
    try {
      this.chosen = JSON.parse(await readFile(join(this.dir, 'choice.json'), 'utf8')) as {
        version: string;
        when: UpdateChoice;
      };
    } catch {
      this.chosen = null;
    }
  }

  /** "When the shop next starts": the first check after a restart installs that version. */
  async installIfChosenAtStart(): Promise<boolean> {
    if (this.get().choice !== 'startup' || !this.status.downloaded) return false;
    // Forgotten first, so an update that fails (and puts the old version back) isn't tried at
    // every start; tonight's automatic install still applies if it is on.
    this.chosen = null;
    await rm(join(this.dir, 'choice.json'), { force: true });
    await this.install();
    return true;
  }

  /** The installer leaves last-result.json; it goes into the audit log and alerts once. */
  private async reportLastResult() {
    const file = join(this.dir, 'last-result.json');
    if (!existsSync(file)) return this.loadReported();
    try {
      const r = JSON.parse(stripBom(await readFile(file, 'utf8'))) as UpdateResult;
      this.status.lastResult = r;
      await audit(
        this.db,
        { userId: null },
        {
          action: r.ok ? 'update.installed' : 'update.failed',
          entity: 'software',
          before: r.from ? { version: r.from } : undefined,
          after: r,
        },
      );
      if (!r.ok)
        await this.db.alert.create({
          data: {
            kind: 'UPDATE_FAILED',
            severity: 'error',
            message: `The update to ${r.version} did not work and the previous version was put back: ${r.message}`,
          },
        });
      await rename(file, join(this.dir, 'last-result.reported.json'));
    } catch {
      // A damaged file is left for a person to read.
    }
  }

  /** The last result that was already reported, for the screen after a restart. */
  private async loadReported() {
    const file = join(this.dir, 'last-result.reported.json');
    if (this.status.lastResult || !existsSync(file)) return;
    try {
      this.status.lastResult = JSON.parse(stripBom(await readFile(file, 'utf8'))) as UpdateResult;
    } catch {
      // ignore
    }
  }
}

/**
 * Windows PowerShell 5.1 writes UTF-8 files with a byte-order mark, which JSON.parse refuses; the
 * installer's last-result.json comes from it.
 */
const stripBom = (text: string) => text.replace(/^\uFEFF/, '');

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}
