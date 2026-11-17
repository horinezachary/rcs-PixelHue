// HTTP client for a PixelHue switcher (Q8, and the P10/P20/P80 that share its Open API).
//
// How a session starts, as in PixelHue's own Companion module (bitfocus/companion-module-pixelhue-switcher)
// and the PixelFlow OpenAPI manual V2.0.1:
//   1. GET https://<host>:19998/unico/v1/ucenter/device-list   (self-signed certificate) lists the device(s)
//      and the HTTP port of each one's API.
//   2. GET http://<host>:<api port>/unico/v1/node/open-detail  gives the serial number and the start time.
//   3. Every other request carries Authorization: an HS256 JWT of {"SN": serial} signed with the start time.
// The token changes when the switcher restarts, so a failed request drops the session and the next poll
// starts a new one. There is no user login.

import { createHmac } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export const DISCOVERY_PORT = 19998;
export const MODELS: Record<number, string> = { 29974: 'Q8', 28944: 'P20', 28945: 'P10', 30006: 'P80' };

export class Q8Error extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message);
  }
}

export interface DiscoveredDevice {
  SN: string;
  modelId: number;
  deviceName?: string;
  ip?: string;
  protocols?: { linkType: string; port: number }[];
}

export interface Session {
  apiPort: number;
  serial: string;
  token: string;
  device: DiscoveredDevice;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** The HS256 JWT the switcher expects: {"SN": serial}, no timestamps, signed with the start time. */
export function makeToken(serial: string, startTime: string | number): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ SN: serial }));
  const sig = createHmac('sha256', String(startTime)).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

interface RequestOptions {
  method?: 'GET' | 'PUT' | 'POST';
  body?: unknown;
  token?: string;
  secure?: boolean;
  timeoutMs: number;
}

function request<T>(host: string, port: number, path: string, o: RequestOptions): Promise<T> {
  const lib = o.secure ? https : http;
  const payload = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body));
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host,
        port,
        path,
        method: o.method ?? 'GET',
        timeout: o.timeoutMs,
        // The switcher's discovery port uses a self-signed certificate; it carries no secrets.
        ...(o.secure ? { rejectUnauthorized: false } : {}),
        headers: {
          Accept: 'application/json',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...(o.token ? { Authorization: o.token } : {})
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if ((res.statusCode ?? 0) >= 400) return reject(new Q8Error(`HTTP ${res.statusCode} from ${path.replace('/unico/v1/', '')}`));
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            return reject(new Q8Error(`Not JSON from ${path.replace('/unico/v1/', '')}`));
          }
          // The manual's examples say 200, real switchers answer 0.
          if (json && typeof json.code === 'number' && json.code !== 0 && json.code !== 200) {
            return reject(new Q8Error(`${path.replace('/unico/v1/', '')}: ${json.message || 'error'} (${json.code})`, json.code));
          }
          resolve(json as T);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Q8Error('No answer')));
    req.on('error', (e: NodeJS.ErrnoException) =>
      reject(e instanceof Q8Error ? e : new Q8Error(e.code === 'ECONNREFUSED' ? 'Connection refused' : e.code === 'EHOSTUNREACH' ? 'Host unreachable' : e.message))
    );
    if (payload) req.write(payload);
    req.end();
  });
}

export class Q8Client {
  session: Session | null = null;

  constructor(
    readonly host: string,
    /** The discovery (ucenter) port. */
    readonly port = DISCOVERY_PORT,
    readonly timeoutMs = 3000
  ) {}

  /** Finds the device and its API port, and makes the token. Reads only. */
  async connect(): Promise<Session> {
    const list = await request<{ data?: { list?: DiscoveredDevice[] } }>(this.host, this.port, '/unico/v1/ucenter/device-list', { secure: true, timeoutMs: this.timeoutMs });
    const devices = Array.isArray(list?.data?.list) ? list.data!.list! : [];
    if (!devices.length) throw new Q8Error('No PixelHue device at this address');
    // Never move to a different device than the address given: prefer the one reporting this IP.
    const device = devices.find((d) => d.ip === this.host) ?? devices[0]!;
    const apiPort = device.protocols?.find((p) => p.linkType === 'http')?.port;
    if (!apiPort) throw new Q8Error('The device did not say which port its API is on');
    const open = await request<{ data?: { sn?: string; startTime?: string | number } }>(this.host, apiPort, '/unico/v1/node/open-detail', { timeoutMs: this.timeoutMs });
    const serial = open?.data?.sn;
    if (!serial || open.data?.startTime === undefined) throw new Q8Error('The device did not give its serial number');
    this.session = { apiPort, serial, token: makeToken(serial, open.data.startTime), device };
    return this.session;
  }

  private async call<T>(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<T> {
    const s = this.session ?? (await this.connect());
    try {
      return await request<T>(this.host, s.apiPort, `/unico/v1/${path}`, { method, body, token: s.token, timeoutMs: this.timeoutMs });
    } catch (e) {
      // A restarted switcher has a new token and maybe a new port: start over on the next call.
      this.session = null;
      throw e;
    }
  }

  get<T = any>(path: string): Promise<T> {
    return this.call<T>('GET', path);
  }
  put<T = any>(path: string, body: unknown): Promise<T> {
    return this.call<T>('PUT', path, body);
  }
  post<T = any>(path: string, body: unknown): Promise<T> {
    return this.call<T>('POST', path, body);
  }
}
