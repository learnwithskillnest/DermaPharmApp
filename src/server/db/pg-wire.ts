/**
 * Minimal PostgreSQL wire-protocol (v3) client.
 *
 * Supports: TLS (sslmode=require/verify-full), SCRAM-SHA-256 / MD5 / cleartext
 * auth, the extended query protocol with server-side parameter binding (no
 * string interpolation, so no SQL injection through parameters), and the simple
 * query protocol for multi-statement migrations.
 *
 * It exists because the build environment could not install `pg`. The rest of
 * the app talks to the `Queryable` interface in ./db.ts, so swapping this for
 * node-postgres is a one-file change (see docs/DATABASE.md).
 */
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export interface PgConnectOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: false | { rejectUnauthorized: boolean; ca?: string; servername?: string };
  applicationName?: string;
  connectTimeoutMs?: number;
}

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
  command: string;
}

export class PgError extends Error {
  code: string;
  detail?: string;
  constraint?: string;
  table?: string;
  severity?: string;
  constructor(fields: Record<string, string>) {
    super(fields.M ?? 'PostgreSQL error');
    this.name = 'PgError';
    this.code = fields.C ?? 'XX000';
    this.detail = fields.D;
    this.constraint = fields.n;
    this.table = fields.t;
    this.severity = fields.S;
  }
}

/** Wrap a value to send it as JSON (json/jsonb columns). */
export class JsonParam {
  constructor(readonly value: unknown) {}
}
export const asJson = (value: unknown) => new JsonParam(value);

interface Field {
  name: string;
  typeOid: number;
}

type Pending = {
  resolve: (r: QueryResult<any>) => void;
  reject: (e: Error) => void;
  fields: Field[];
  rows: Record<string, unknown>[];
  command: string;
  error?: PgError;
};

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function parseArray(text: string, parseItem: (s: string) => unknown): unknown[] {
  // Handles one-dimensional arrays, quoted elements and NULLs.
  if (text === '{}') return [];
  const out: unknown[] = [];
  let i = 1;
  while (i < text.length - 1) {
    let item = '';
    let quoted = false;
    if (text[i] === '"') {
      quoted = true;
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') i++;
        item += text[i];
        i++;
      }
      i++; // closing quote
    } else {
      while (i < text.length - 1 && text[i] !== ',') item += text[i++];
    }
    out.push(!quoted && item === 'NULL' ? null : parseItem(item));
    i++; // comma
  }
  return out;
}

function parseInt8(s: string): number {
  const b = BigInt(s);
  if (b > MAX_SAFE || b < -MAX_SAFE) throw new Error(`int8 value ${s} exceeds safe integer range`);
  return Number(s);
}

export function parseValue(typeOid: number, text: string): unknown {
  switch (typeOid) {
    case 16:
      return text === 't';
    case 20:
      return parseInt8(text);
    case 21:
    case 23:
    case 26:
      return Number.parseInt(text, 10);
    case 700:
    case 701:
    case 1700:
      return Number(text);
    case 114:
    case 3802:
      return JSON.parse(text);
    case 1114:
      return new Date(text.replace(' ', 'T') + 'Z');
    case 1184:
      return new Date(text.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
    case 1000:
      return parseArray(text, (s) => s === 't');
    case 1005:
    case 1007:
      return parseArray(text, (s) => Number.parseInt(s, 10));
    case 1016:
      return parseArray(text, parseInt8);
    case 1009:
    case 1015:
    case 2951:
      return parseArray(text, (s) => s);
    default:
      return text; // text, varchar, uuid, date (YYYY-MM-DD), enums, citext, etc.
  }
}

function quoteArrayItem(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  const s = serializeParam(v) as string;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function serializeParam(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof JsonParam) return JSON.stringify(v.value);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Cannot bind a non-finite number');
    return String(v);
  }
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return '{' + v.map(quoteArrayItem).join(',') + '}';
  if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

class Writer {
  private parts: Buffer[] = [];
  private len = 0;
  int32(n: number) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(n);
    return this.push(b);
  }
  int16(n: number) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(n);
    return this.push(b);
  }
  cstr(s: string) {
    return this.push(Buffer.from(s + '\0', 'utf8'));
  }
  bytes(b: Buffer) {
    return this.push(b);
  }
  private push(b: Buffer) {
    this.parts.push(b);
    this.len += b.length;
    return this;
  }
  /** Frame as a typed message: type byte + int32 length (incl. itself) + body. */
  frame(type: string | null): Buffer {
    const body = Buffer.concat(this.parts, this.len);
    const header = Buffer.alloc(type ? 5 : 4);
    if (type) {
      header.write(type, 0, 'ascii');
      header.writeInt32BE(body.length + 4, 1);
    } else {
      header.writeInt32BE(body.length + 4, 0);
    }
    return Buffer.concat([header, body]);
  }
}

function hmac(key: Buffer, data: string | Buffer) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

export class PgConnection {
  private socket!: net.Socket | tls.TLSSocket;
  private buffer: Buffer = Buffer.alloc(0);
  private queue: Pending[] = [];
  private current: Pending | null = null;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private scram: { nonce: string; clientFirstBare: string; serverSignature?: Buffer } | null = null;
  private opts!: PgConnectOptions;
  closed = false;
  broken = false;
  txStatus = 'I';
  onError?: (err: Error) => void;

  async connect(opts: PgConnectOptions): Promise<void> {
    this.opts = opts;
    const raw = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect({ host: opts.host, port: opts.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error('PostgreSQL connection timed out'));
      }, opts.connectTimeoutMs ?? 10_000);
      s.once('connect', () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    raw.setNoDelay(true);
    raw.setKeepAlive(true, 30_000);

    if (opts.ssl) {
      // SSLRequest
      const req = Buffer.alloc(8);
      req.writeInt32BE(8, 0);
      req.writeInt32BE(80877103, 4);
      raw.write(req);
      const answer = await new Promise<string>((resolve, reject) => {
        raw.once('data', (d) => resolve(d.toString('ascii', 0, 1)));
        raw.once('error', reject);
      });
      if (answer !== 'S') throw new Error('PostgreSQL server refused TLS (sslmode requires it)');
      this.socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const t = tls.connect({
          socket: raw,
          servername: opts.ssl ? (opts.ssl.servername ?? opts.host) : undefined,
          rejectUnauthorized: opts.ssl ? opts.ssl.rejectUnauthorized : true,
          ca: opts.ssl ? opts.ssl.ca : undefined,
        });
        t.once('secureConnect', () => resolve(t));
        t.once('error', reject);
      });
    } else {
      this.socket = raw;
    }

    this.socket.on('data', (d: Buffer) => this.onData(d));
    this.socket.on('error', (e) => this.fail(e));
    this.socket.on('close', () => this.fail(new Error('PostgreSQL connection closed')));

    const ready = new Promise<void>((resolve, reject) => {
      this.readyWaiter = { resolve, reject };
    });
    const w = new Writer().int32(196608);
    w.cstr('user').cstr(opts.user);
    w.cstr('database').cstr(opts.database);
    w.cstr('client_encoding').cstr('UTF8');
    w.cstr('application_name').cstr(opts.applicationName ?? 'glowderma');
    w.cstr('TimeZone').cstr('UTC');
    w.bytes(Buffer.from([0]));
    this.socket.write(w.frame(null));
    await ready;
  }

  private fail(err: Error) {
    if (this.closed && !this.current && this.queue.length === 0) return;
    this.broken = true;
    this.closed = true;
    if (this.readyWaiter) {
      this.readyWaiter.reject(err);
      this.readyWaiter = null;
    }
    const all = [this.current, ...this.queue].filter(Boolean) as Pending[];
    this.current = null;
    this.queue = [];
    for (const p of all) p.reject(err);
    this.onError?.(err);
  }

  private onData(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 5) {
      const type = String.fromCharCode(this.buffer[0]);
      const len = this.buffer.readInt32BE(1);
      if (this.buffer.length < len + 1) break;
      const body = this.buffer.subarray(5, len + 1);
      this.buffer = this.buffer.subarray(len + 1);
      try {
        this.handle(type, body);
      } catch (e) {
        this.fail(e as Error);
        this.socket.destroy();
        return;
      }
    }
  }

  private handle(type: string, body: Buffer) {
    switch (type) {
      case 'R':
        return this.handleAuth(body);
      case 'S': // ParameterStatus
      case 'K': // BackendKeyData
      case 'N': // Notice
      case 'A': // Notification
      case '1': // ParseComplete
      case '2': // BindComplete
      case 'n': // NoData
      case 's': // PortalSuspended
      case 'I': // EmptyQueryResponse
        return;
      case 'T': {
        if (!this.current) return;
        const count = body.readInt16BE(0);
        let off = 2;
        const fields: Field[] = [];
        for (let i = 0; i < count; i++) {
          const end = body.indexOf(0, off);
          const name = body.toString('utf8', off, end);
          off = end + 1;
          const typeOid = body.readInt32BE(off + 6);
          off += 18;
          fields.push({ name, typeOid });
        }
        this.current.fields = fields;
        return;
      }
      case 'D': {
        if (!this.current) return;
        const count = body.readInt16BE(0);
        let off = 2;
        const row: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          const len = body.readInt32BE(off);
          off += 4;
          const f = this.current.fields[i];
          if (len === -1) {
            row[f.name] = null;
          } else {
            row[f.name] = parseValue(f.typeOid, body.toString('utf8', off, off + len));
            off += len;
          }
        }
        this.current.rows.push(row);
        return;
      }
      case 'C': {
        if (this.current) this.current.command = body.toString('utf8', 0, body.length - 1);
        return;
      }
      case 'E': {
        const fields: Record<string, string> = {};
        let off = 0;
        while (off < body.length && body[off] !== 0) {
          const code = String.fromCharCode(body[off]);
          const end = body.indexOf(0, off + 1);
          fields[code] = body.toString('utf8', off + 1, end);
          off = end + 1;
        }
        const err = new PgError(fields);
        if (this.current) {
          this.current.error = err;
        } else if (this.readyWaiter) {
          this.readyWaiter.reject(err);
          this.readyWaiter = null;
        }
        return;
      }
      case 'Z': {
        this.txStatus = String.fromCharCode(body[0]);
        if (this.readyWaiter) {
          this.readyWaiter.resolve();
          this.readyWaiter = null;
        }
        const done = this.current;
        this.current = null;
        if (done) {
          if (done.error) done.reject(done.error);
          else {
            const n = /(\d+)$/.exec(done.command);
            done.resolve({
              rows: done.rows,
              rowCount: n ? Number(n[1]) : done.rows.length,
              command: done.command.split(' ')[0] ?? '',
            });
          }
        }
        this.next();
        return;
      }
      default:
        return;
    }
  }

  private handleAuth(body: Buffer) {
    const code = body.readInt32BE(0);
    const pw = this.opts.password;
    if (code === 0) return; // AuthenticationOk
    if (code === 3) {
      this.socket.write(new Writer().cstr(pw).frame('p'));
      return;
    }
    if (code === 5) {
      const salt = body.subarray(4, 8);
      const inner = crypto
        .createHash('md5')
        .update(pw + this.opts.user)
        .digest('hex');
      const outer = crypto
        .createHash('md5')
        .update(Buffer.concat([Buffer.from(inner), salt]))
        .digest('hex');
      this.socket.write(new Writer().cstr('md5' + outer).frame('p'));
      return;
    }
    if (code === 10) {
      const mechs = body.toString('utf8', 4).split('\0');
      if (!mechs.includes('SCRAM-SHA-256')) throw new Error('Server offers no supported SASL mechanism');
      const nonce = crypto.randomBytes(18).toString('base64');
      const clientFirstBare = `n=*,r=${nonce}`;
      this.scram = { nonce, clientFirstBare };
      const msg = Buffer.from('n,,' + clientFirstBare);
      this.socket.write(new Writer().cstr('SCRAM-SHA-256').int32(msg.length).bytes(msg).frame('p'));
      return;
    }
    if (code === 11) {
      if (!this.scram) throw new Error('Unexpected SASLContinue');
      const serverFirst = body.toString('utf8', 4);
      const attrs = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
      const r = attrs.r;
      const s = attrs.s;
      const i = Number(attrs.i);
      if (!r || !r.startsWith(this.scram.nonce) || !s || !i) throw new Error('Invalid SCRAM server-first message');
      const salted = crypto.pbkdf2Sync(pw.normalize('NFKC'), Buffer.from(s, 'base64'), i, 32, 'sha256');
      const clientKey = hmac(salted, 'Client Key');
      const storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const clientFinalNoProof = `c=biws,r=${r}`;
      const authMessage = `${this.scram.clientFirstBare},${serverFirst},${clientFinalNoProof}`;
      const clientSig = hmac(storedKey, authMessage);
      const proof = Buffer.alloc(clientKey.length);
      for (let k = 0; k < clientKey.length; k++) proof[k] = clientKey[k] ^ clientSig[k];
      const serverKey = hmac(salted, 'Server Key');
      this.scram.serverSignature = hmac(serverKey, authMessage);
      const final = Buffer.from(`${clientFinalNoProof},p=${proof.toString('base64')}`);
      this.socket.write(new Writer().bytes(final).frame('p'));
      return;
    }
    if (code === 12) {
      const final = body.toString('utf8', 4);
      const v = /v=([^,]+)/.exec(final)?.[1];
      if (!v || !this.scram?.serverSignature) throw new Error('Invalid SCRAM server-final message');
      const got = Buffer.from(v, 'base64');
      if (got.length !== this.scram.serverSignature.length || !crypto.timingSafeEqual(got, this.scram.serverSignature)) {
        throw new Error('SCRAM server signature mismatch — refusing connection');
      }
      return;
    }
    throw new Error(`Unsupported PostgreSQL auth method ${code}`);
  }

  private next() {
    if (this.current || this.queue.length === 0) return;
    this.current = this.queue.shift()!;
    const anyCur = this.current as Pending & { send?: () => void };
    anyCur.send?.();
  }

  private enqueue<T>(send: () => void): Promise<QueryResult<T>> {
    if (this.closed) return Promise.reject(new Error('Connection is closed'));
    return new Promise<QueryResult<T>>((resolve, reject) => {
      const p = { resolve, reject, fields: [], rows: [], command: '', send } as unknown as Pending;
      this.queue.push(p);
      this.next();
    });
  }

  /** Extended protocol query with bound parameters. */
  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.enqueue<T>(() => {
      const parse = new Writer().cstr('').cstr(sql).int16(0).frame('P');
      const bind = new Writer().cstr('').cstr('').int16(0).int16(params.length);
      for (const p of params) {
        const s = serializeParam(p);
        if (s === null) bind.int32(-1);
        else {
          const b = Buffer.from(s, 'utf8');
          bind.int32(b.length).bytes(b);
        }
      }
      bind.int16(0);
      const describe = new Writer().bytes(Buffer.from('P\0', 'ascii')).frame('D');
      const execute = new Writer().cstr('').int32(0).frame('E');
      const sync = new Writer().frame('S');
      this.socket.write(Buffer.concat([parse, bind.frame('B'), describe, execute, sync]));
    });
  }

  /** Simple protocol; allows multiple statements (used by migrations only). */
  simpleQuery(sql: string): Promise<QueryResult> {
    return this.enqueue(() => {
      this.socket.write(new Writer().cstr(sql).frame('Q'));
    });
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end(new Writer().frame('X'));
    } catch {
      /* ignore */
    }
  }
}

export function parseDatabaseUrl(url: string): PgConnectOptions {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('DATABASE_URL must start with postgres://');
  const sslmode = u.searchParams.get('sslmode') ?? 'disable';
  let ssl: PgConnectOptions['ssl'] = false;
  if (sslmode === 'require') ssl = { rejectUnauthorized: false };
  if (sslmode === 'verify-full' || sslmode === 'verify-ca') ssl = { rejectUnauthorized: true };
  return {
    host: u.hostname || '127.0.0.1',
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    ssl,
  };
}
