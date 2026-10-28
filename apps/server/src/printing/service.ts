import type { Db } from '../db';
import type { AppConfig } from '../config';
import { sendToPrinter, type PrinterConfig } from './drivers';
import { stampTest } from './escpos';

export interface PrintResult {
  printed: boolean;
  error?: string;
}

/**
 * Sends documents to a counter's printer. Printing happens after the bill is saved; a printer
 * problem never undoes a sale, it is reported back so the cashier can reprint.
 */
export class PrintService {
  /** Last job per counter, for tests and the "file" driver preview. */
  readonly lastJobs = new Map<string, Buffer>();

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    /** Test mode: every slip says TEST and the cash drawer stays shut. */
    private readonly testMode: () => boolean = () => false,
  ) {}

  async printerFor(counterId: string | null | undefined): Promise<PrinterConfig> {
    if (!counterId) return { driver: 'none' };
    const counter = await this.db.counter.findUnique({ where: { id: counterId } });
    return (counter?.printer as PrinterConfig | undefined) ?? { driver: 'none' };
  }

  async print(
    counterId: string | null | undefined,
    data: Buffer,
    name: string,
  ): Promise<PrintResult> {
    if (this.testMode()) data = stampTest(data);
    this.lastJobs.set(counterId ?? 'none', data);
    if (!data.length) return { printed: false };
    try {
      const printer = await this.printerFor(counterId);
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
