import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripEscPos } from './escpos';

export type PrinterConfig =
  | { driver: 'none' }
  /** A network thermal printer on raw port 9100. */
  | { driver: 'network'; host: string; port?: number }
  /** Writes .bin and .txt files; for development and tests. */
  | { driver: 'file'; path?: string }
  /** A USB printer shared in Windows; bytes are copied raw to \\localhost\<share>. */
  | { driver: 'windows-share'; share: string };

export async function sendToPrinter(
  config: PrinterConfig,
  data: Buffer,
  opts: { dataDir: string; name: string },
): Promise<void> {
  switch (config.driver) {
    case 'none':
      return;
    case 'network':
      return sendNetwork(config.host, config.port ?? 9100, data);
    case 'file': {
      const dir = config.path || join(opts.dataDir, 'receipts');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${opts.name}.bin`), data);
      await writeFile(join(dir, `${opts.name}.txt`), stripEscPos(data), 'utf8');
      return;
    }
    case 'windows-share': {
      const file = join(tmpdir(), `aruna-${opts.name}-${Date.now()}.bin`);
      await writeFile(file, data);
      await new Promise<void>((resolve, reject) => {
        execFile(
          'cmd',
          ['/c', 'copy', '/b', file, `\\\\localhost\\${config.share}`],
          { windowsHide: true },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      return;
    }
  }
}

function sendNetwork(host: string, port: number, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, timeout: 5000 }, () => {
      socket.end(data, () => resolve());
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`Printer ${host}:${port} did not answer`));
    });
    socket.on('error', reject);
  });
}
