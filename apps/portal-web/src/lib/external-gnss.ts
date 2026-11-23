// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * External GNSS receivers through the Web Serial API.
 *
 * Chrome reaches a paired Bluetooth Classic receiver (Serial Port
 * Profile) on Android and on desktop, and a USB receiver on desktop.
 * The receiver streams NMEA, which NmeaFixBuilder turns into fixes.
 * Other browsers have no way to reach a receiver; there the device's
 * own location is used, which a receiver can still feed on Android
 * through a mock location app.
 */
import { NmeaFixBuilder, type GnssFix } from './nmea';

/** Bluetooth Serial Port Profile service class. */
const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

/** Rate for a wired port, the common NMEA default; Bluetooth ignores it. */
const DEFAULT_BAUD = 9600;

/** The slice of the Web Serial API used here. */
interface SerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  getInfo?(): { bluetoothServiceClassId?: string; usbVendorId?: number };
}
interface SerialLike {
  requestPort(options?: { allowedBluetoothServiceClassIds?: string[] }): Promise<SerialPortLike>;
}

function serialApi(): SerialLike | null {
  if (typeof navigator === 'undefined') return null;
  const s = (navigator as Navigator & { serial?: SerialLike }).serial;
  return s ?? null;
}

/** Whether this browser can connect to a receiver at all. */
export function externalGnssSupported(): boolean {
  return serialApi() !== null;
}

export interface ExternalGnssHandlers {
  onFix: (fix: GnssFix) => void;
  /** Lines are arriving but none holds a usable fix yet. */
  onNoFix: () => void;
  /** The connection ended; `error` is set when it failed. */
  onClose: (error: string | null) => void;
}

/** One open receiver connection. */
export class ExternalGnssConnection {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;

  private constructor(
    private readonly port: SerialPortLike,
    readonly name: string,
  ) {}

  /**
   * Ask the user to pick a receiver and open it. Must run from a tap.
   * Throws when the browser has no Web Serial or the user cancels.
   */
  static async connect(
    handlers: ExternalGnssHandlers,
    baudRate = DEFAULT_BAUD,
  ): Promise<ExternalGnssConnection> {
    const serial = serialApi();
    if (!serial) throw new Error('This browser cannot connect to a GNSS receiver.');
    const port = await serial.requestPort({ allowedBluetoothServiceClassIds: [SPP_UUID] });
    await port.open({ baudRate });
    const info = port.getInfo?.() ?? {};
    const name = info.bluetoothServiceClassId ? 'Bluetooth receiver' : 'USB receiver';
    const conn = new ExternalGnssConnection(port, name);
    void conn.readLoop(handlers);
    return conn;
  }

  private async readLoop(h: ExternalGnssHandlers): Promise<void> {
    const builder = new NmeaFixBuilder();
    const decoder = new TextDecoder();
    let buffer = '';
    let linesWithoutFix = 0;
    let error: string | null = null;
    try {
      while (!this.closed && this.port.readable) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            // A receiver that is not sending NMEA would grow this forever.
            if (buffer.length > 16_384) buffer = buffer.slice(-4096);
            let nl = buffer.indexOf('\n');
            while (nl !== -1) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              const fix = builder.push(line);
              if (fix) {
                linesWithoutFix = 0;
                h.onFix(fix);
              } else if (/^\$..GGA,/.test(line.trim())) {
                linesWithoutFix += 1;
                if (linesWithoutFix === 1 || linesWithoutFix % 10 === 0) h.onNoFix();
              }
              nl = buffer.indexOf('\n');
            }
          }
        } finally {
          this.reader.releaseLock();
          this.reader = null;
        }
        if (this.closed) break;
      }
    } catch (e) {
      if (!this.closed) error = e instanceof Error ? e.message : String(e);
    }
    await this.port.close().catch(() => undefined);
    h.onClose(this.closed ? null : (error ?? 'The receiver stopped sending.'));
  }

  /** Close the connection. Safe to call more than once. */
  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.reader?.cancel().catch(() => undefined);
  }
}
