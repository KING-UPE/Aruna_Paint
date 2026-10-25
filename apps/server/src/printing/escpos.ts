/**
 * A small ESC/POS builder for 80 mm thermal printers: text, alignment, bold, double size,
 * paper cut and the cash drawer kick. Receipts print silently from the server.
 */
const ESC = 0x1b;
const GS = 0x1d;

export class EscPos {
  private chunks: Buffer[] = [];

  constructor(public readonly width = 48) {
    this.raw([ESC, 0x40]); // initialise
  }

  raw(bytes: number[]): this {
    this.chunks.push(Buffer.from(bytes));
    return this;
  }

  text(s: string): this {
    // Printers take code page 437/1252; anything outside ASCII is replaced.
    this.chunks.push(Buffer.from(s.replace(/[^\x20-\x7e\n]/g, '?'), 'latin1'));
    return this;
  }

  line(s = ''): this {
    return this.text(`${s}\n`);
  }

  align(a: 'left' | 'center' | 'right'): this {
    return this.raw([ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2]);
  }

  bold(on: boolean): this {
    return this.raw([ESC, 0x45, on ? 1 : 0]);
  }

  /** Double width and height for the big net total. */
  big(on: boolean): this {
    return this.raw([GS, 0x21, on ? 0x11 : 0x00]);
  }

  rule(ch = '-'): this {
    return this.line(ch.repeat(this.width));
  }

  /** Left text and right text on one line. */
  pair(left: string, right: string, width = this.width): this {
    const space = Math.max(1, width - left.length - right.length);
    if (left.length + right.length + 1 > width) {
      return this.line(left).line(right.padStart(width));
    }
    return this.line(`${left}${' '.repeat(space)}${right}`);
  }

  feed(lines = 1): this {
    return this.raw([ESC, 0x64, lines]);
  }

  cut(): this {
    return this.feed(3).raw([GS, 0x56, 0x42, 0x00]);
  }

  /** Pulse pin 2 to open the cash drawer. */
  openDrawer(): this {
    return this.raw([ESC, 0x70, 0x00, 0x19, 0xfa]);
  }

  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Plain-text copy of what was printed, for previews and the "file" driver. */
export function stripEscPos(buf: Buffer): string {
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b === ESC || b === GS) {
      const cmd = buf[i + 1];
      if (b === ESC && cmd === 0x40) i += 1;
      else if (b === ESC && cmd === 0x70) i += 4;
      else if (b === GS && cmd === 0x56) i += 3;
      else i += 2;
      continue;
    }
    if (b === 0x0a || (b >= 0x20 && b <= 0x7e)) out.push(String.fromCharCode(b));
  }
  return out.join('');
}
