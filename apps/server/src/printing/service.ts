import type { SettingsService } from '../core/settings';
import type { AppConfig } from '../config';
import { sendToPrinter, type PrinterConfig } from './drivers';
import { stampTest } from './escpos';

export interface PrintResult {
  printed: boolean;
  error?: string;
}

/**
 * Sends documents to the shop's receipt printer (Settings → Receipt printer; every PC prints on
 * it). Printing happens after the bill is saved; a printer problem never undoes a sale, it is
 * reported back so the cashier can reprint.
 */
export class PrintService {
  /** The last job sent, for tests and the "file" driver preview. */
  lastJob: Buffer | null = null;

  constructor(
    private readonly settings: SettingsService,
    private readonly config: AppConfig,
    /** Test mode: every slip says TEST. */
    private readonly testMode: () => boolean = () => false,
  ) {}

  async printer(): Promise<PrinterConfig> {
    const p = await this.settings.get('printer');
    switch (p.driver) {
      case 'network':
        return { driver: 'network', host: p.host, port: p.port };
      case 'windows-share':
        return { driver: 'windows-share', share: p.share };
      case 'file':
        return { driver: 'file', path: p.path };
      default:
        return { driver: 'none' };
    }
  }

  async print(data: Buffer, name: string): Promise<PrintResult> {
    if (this.testMode()) data = stampTest(data);
    this.lastJob = data;
    if (!data.length) return { printed: false };
    try {
      const printer = await this.printer();
      await sendToPrinter(printer, data, {
        dataDir: this.config.dataDir,
        name: name.replace(/[^\w.-]/g, '_'),
      });
      return { printed: printer.driver !== 'none' };
    } catch (err) {
      return { printed: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
