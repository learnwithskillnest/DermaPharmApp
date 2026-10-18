import type { IncomingMessage } from 'node:http';
import { HttpError } from './errors.ts';

export interface UploadedFile {
  field: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface ParsedBody {
  raw: Buffer;
  form: Record<string, string>;
  /** All values for repeated keys (e.g. checkboxes, row arrays). */
  formAll: Record<string, string[]>;
  json: unknown;
  files: UploadedFile[];
}

export async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new HttpError(413, 'The request is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'The request is too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function addField(body: ParsedBody, key: string, value: string) {
  // Strip NUL and normalise line endings; length limits are enforced by zod schemas.
  const v = value.replace(/\0/g, '').replace(/\r\n/g, '\n');
  (body.formAll[key] ??= []).push(v);
  if (!(key in body.form)) body.form[key] = v;
}

export function parseMultipart(raw: Buffer, contentType: string, body: ParsedBody) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new HttpError(400, 'Malformed upload.');
  const boundary = Buffer.from('--' + (m[1] ?? m[2]).trim());
  let pos = raw.indexOf(boundary);
  let parts = 0;
  while (pos !== -1) {
    const start = pos + boundary.length;
    if (raw.subarray(start, start + 2).toString() === '--') break;
    const headerEnd = raw.indexOf('\r\n\r\n', start);
    if (headerEnd === -1) break;
    const headers = raw.subarray(start + 2, headerEnd).toString('utf8');
    const next = raw.indexOf(boundary, headerEnd + 4);
    if (next === -1) throw new HttpError(400, 'Malformed upload.');
    const data = raw.subarray(headerEnd + 4, next - 2); // strip trailing CRLF
    if (++parts > 50) throw new HttpError(400, 'Too many form fields.');
    const disp = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disp)?.[1];
    const filename = /\bfilename="([^"]*)"/i.exec(disp)?.[1];
    const type = /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim() ?? 'application/octet-stream';
    if (name) {
      if (filename !== undefined) {
        if (data.length > 0) body.files.push({ field: name, filename: filename.replace(/[\\/]/g, '_').slice(0, 200), contentType: type, data: Buffer.from(data) });
      } else addField(body, name, data.toString('utf8'));
    }
    pos = next;
  }
}

export async function parseBody(req: IncomingMessage, opts: { multipart?: boolean; maxBytes?: number }): Promise<ParsedBody> {
  const ct = (req.headers['content-type'] ?? '').toLowerCase();
  const isMultipart = ct.startsWith('multipart/form-data');
  if (isMultipart && !opts.multipart) throw new HttpError(415, 'Uploads are not accepted here.');
  const limit = opts.maxBytes ?? (isMultipart ? 6_000_000 : 256_000);
  const raw = await readRaw(req, limit);
  const body: ParsedBody = { raw, form: {}, formAll: {}, json: undefined, files: [] };
  if (ct.startsWith('application/x-www-form-urlencoded')) {
    for (const [k, v] of new URLSearchParams(raw.toString('utf8'))) addField(body, k, v);
  } else if (ct.startsWith('application/json')) {
    if (raw.length) {
      try {
        body.json = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new HttpError(400, 'Request body is not valid JSON.');
      }
    }
  } else if (isMultipart) {
    parseMultipart(raw, req.headers['content-type'] ?? '', body);
  }
  return body;
}
