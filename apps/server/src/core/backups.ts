import { execFile } from 'node:child_process';
import { copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { shopDate, shopDateParts } from '@aruna/shared';
import type { AppConfig } from '../config';
import type { Db } from '../db';
import type { SettingsService } from './settings';

export type BackupKind = 'DAY_END' | 'NIGHTLY' | 'MANUAL' | 'PRE_UPDATE';

const FILE_RE = /^aruna-(\d{8})-(\d{4})-[a-z_]+\.dump$/;

/** pg_dump rejects Prisma's "?schema=" parameter, so it gets a plain libpq URL. */
export function libpqUrl(databaseUrl: string): string {
  const u = new URL(databaseUrl);
  u.searchParams.delete('schema');
  return u.toString();
}

/**
 * Automatic backups at day end and every night, compressed and named by date. Keeps 30 daily and
 * 12 monthly copies, plus a second copy on a USB or second drive. Backups are not encrypted.
 */
export class BackupService {
  private running = new Set<Promise<unknown>>();
  private timer: NodeJS.Timeout | null = null;
  private lastNightly = '';

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly settings: SettingsService,
    /** Backups pause in test mode: the real data isn't changing and the copy is thrown away. */
    private readonly paused: () => boolean = () => false,
  ) {}

  run(kind: BackupKind) {
    if (this.paused()) return Promise.resolve(null);
    const job = this.doRun(kind).finally(() => this.running.delete(job));
    this.running.add(job);
    return job;
  }

  private async doRun(kind: BackupKind) {
    const cfg = await this.settings.get('backup');
    const folder = cfg.folder || join(this.config.dataDir, 'backups');
    const now = new Date();
    const { yyyy, mm, dd } = shopDateParts(now);
    const hm = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Colombo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(now)
      .replace(':', '');
    const name = `aruna-${yyyy}${mm}${dd}-${hm}-${kind.toLowerCase()}.dump`;
    const path = join(folder, name);
    try {
      await mkdir(folder, { recursive: true });
      await this.pgDump(path);
      const size = (await stat(path)).size;
      let copiedTo = '';
      if (cfg.secondFolder) {
        try {
          await mkdir(cfg.secondFolder, { recursive: true });
          await copyFile(path, join(cfg.secondFolder, name));
          copiedTo = cfg.secondFolder;
        } catch (err) {
          await this.alert(
            'BACKUP_COPY_FAILED',
            `Backup copy to ${cfg.secondFolder} failed: ${String(err)}`,
          );
        }
      }
      await this.prune(folder, cfg.keepDaily, cfg.keepMonthly);
      if (copiedTo) await this.prune(copiedTo, cfg.keepDaily, cfg.keepMonthly);
      return await this.db.backup.create({
        data: { kind, path, sizeBytes: BigInt(size), status: 'OK', copiedTo },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.alert('BACKUP_FAILED', `Backup failed: ${message}`);
      return this.db.backup.create({
        data: { kind, path, status: 'FAILED', error: message.slice(0, 2000) },
      });
    }
  }

  private pgDump(path: string): Promise<void> {
    const bin = this.config.pgBinDir ? join(this.config.pgBinDir, 'pg_dump') : 'pg_dump';
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        [
          '--format=custom',
          '--compress=6',
          '--no-owner',
          `--file=${path}`,
          `--dbname=${libpqUrl(this.config.databaseUrl)}`,
        ],
        { timeout: 10 * 60_000, windowsHide: true },
        (err, _stdout, stderr) =>
          err ? reject(new Error(stderr.trim() || err.message)) : resolve(),
      );
    });
  }

  /** Keeps the newest file of each of the last N days and of each of the last M months. */
  private async prune(folder: string, keepDaily: number, keepMonthly: number) {
    const files = (await readdir(folder))
      .filter((f) => FILE_RE.test(f))
      .sort()
      .reverse();
    const keep = new Set<string>();
    const days = new Set<string>();
    const months = new Set<string>();
    for (const f of files) {
      const day = FILE_RE.exec(f)![1]!;
      if (days.size < keepDaily && !days.has(day)) {
        days.add(day);
        keep.add(f);
      }
      const month = day.slice(0, 6);
      if (months.size < keepMonthly && !months.has(month)) {
        months.add(month);
        keep.add(f);
      }
      // Every backup of a kept day stays (day end and nightly on the same date).
      if (days.has(day)) keep.add(f);
    }
    for (const f of files) if (!keep.has(f)) await unlink(join(folder, f)).catch(() => undefined);
  }

  private async alert(kind: string, message: string) {
    await this.db.alert
      .create({ data: { kind, severity: 'error', message } })
      .catch(() => undefined);
  }

  /** Checks once a minute for the nightly backup time (shop time). */
  startScheduler() {
    this.timer = setInterval(() => {
      void (async () => {
        const cfg = await this.settings.get('backup');
        const hm = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Colombo',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date());
        const today = shopDate();
        if (hm === cfg.nightlyAt && this.lastNightly !== today) {
          this.lastNightly = today;
          await this.run('NIGHTLY');
        }
      })();
    }, 60_000);
    this.timer.unref();
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.running]);
  }
}
