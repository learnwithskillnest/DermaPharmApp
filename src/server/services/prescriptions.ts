import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { App } from '../app.ts';
import type { Queryable } from '../db/db.ts';
import { UserFacingError } from '../http/errors.ts';
import type { UploadedFile } from '../http/body.ts';
import { audit, type Actor } from './audit.ts';
import { sendSafely } from './mail.ts';

export interface PrescriptionRow {
  id: string;
  user_id: string;
  storage_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  patient_name: string;
  doctor_name: string | null;
  doctor_reg_no: string | null;
  issued_on: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  reviewer_id: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  valid_until: string | null;
  delete_after: string;
  created_at: Date;
}

const COLS = `id, user_id, storage_key, original_name, mime_type, size_bytes, patient_name, doctor_name, doctor_reg_no, issued_on::text,
  status, reviewer_id, reviewed_at, review_notes, valid_until::text, delete_after::text, created_at`;

const P_COLS = COLS.split(/,\s*/)
  .map((c) => 'p.' + c)
  .join(', ');

/** Detect file type from magic bytes — never trust the browser's Content-Type or extension. */
export function sniffMime(data: Buffer): 'application/pdf' | 'image/jpeg' | 'image/png' | null {
  if (data.length >= 5 && data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

function storageDir(app: App) {
  return path.resolve(app.config.PRESCRIPTION_STORAGE_DIR);
}

export async function savePrescription(
  app: App,
  userId: string,
  file: UploadedFile | undefined,
  meta: { patientName: string; doctorName: string | null; issuedOn: string | null },
) {
  if (!file) throw new UserFacingError('Choose a prescription file to upload (PDF, JPG or PNG).', 'file');
  if (file.data.length > app.config.PRESCRIPTION_MAX_BYTES) {
    throw new UserFacingError(`The file is too large. The limit is ${Math.round(app.config.PRESCRIPTION_MAX_BYTES / 1_000_000)} MB.`, 'file');
  }
  const mime = sniffMime(file.data);
  if (!mime) throw new UserFacingError('Upload a PDF, JPG or PNG file.', 'file');
  const pending = await app.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM prescriptions WHERE user_id = $1 AND status = 'pending'`, [userId]);
  if ((pending?.n ?? 0) >= 5) throw new UserFacingError('You already have 5 prescriptions awaiting review. Please wait for our pharmacist.', 'too_many');

  const settings = await app.settings.all();
  const ext = mime === 'application/pdf' ? 'pdf' : mime === 'image/png' ? 'png' : 'jpg';
  const key = `${crypto.randomUUID()}.${ext}`;
  const dir = storageDir(app);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(dir, key), file.data, { mode: 0o600, flag: 'wx' });
  const sha = crypto.createHash('sha256').update(file.data).digest('hex');
  const deleteAfter = new Date(Date.now() + settings.pharmacy.rxRetentionDays * 86_400_000).toISOString().slice(0, 10);
  try {
    const row = await app.db.one<{ id: string }>(
      `INSERT INTO prescriptions (user_id, storage_key, original_name, mime_type, size_bytes, sha256, patient_name, doctor_name, issued_on, delete_after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [userId, key, file.filename || `prescription.${ext}`, mime, file.data.length, sha, meta.patientName, meta.doctorName, meta.issuedOn, deleteAfter],
    );
    await audit(app.db, { id: userId, role: 'customer' }, 'prescription.uploaded', 'prescription', row!.id, { size: file.data.length, mime });
    return row!.id;
  } catch (e) {
    await fs.rm(path.join(dir, key), { force: true });
    throw e;
  }
}

export async function prescriptionsForUser(db: Queryable, userId: string) {
  return db.many<PrescriptionRow>(`SELECT ${COLS} FROM prescriptions WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
}

export async function approvedPrescriptions(db: Queryable, userId: string) {
  return db.many<PrescriptionRow>(
    `SELECT ${COLS} FROM prescriptions WHERE user_id = $1 AND status = 'approved' AND (valid_until IS NULL OR valid_until >= current_date) ORDER BY created_at DESC`,
    [userId],
  );
}

export async function getPrescription(db: Queryable, id: string) {
  return db.one<PrescriptionRow & { customer_name: string; customer_email: string; reviewer_name: string | null }>(
    `SELECT ${P_COLS}, u.name AS customer_name, u.email AS customer_email, r.name AS reviewer_name
       FROM prescriptions p JOIN users u ON u.id = p.user_id LEFT JOIN users r ON r.id = p.reviewer_id WHERE p.id = $1`,
    [id],
  );
}

export async function rxQueue(db: Queryable, status: string) {
  return db.many<PrescriptionRow & { customer_name: string }>(
    `SELECT ${P_COLS}, u.name AS customer_name
       FROM prescriptions p JOIN users u ON u.id = p.user_id WHERE p.status = $1::rx_status ORDER BY p.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`,
    [status],
  );
}

/** Streams the stored file. Callers MUST have authorised the viewer; every read is audited. */
export async function readPrescriptionFile(app: App, rx: PrescriptionRow, actor: Actor) {
  const file = path.join(storageDir(app), path.basename(rx.storage_key));
  const data = await fs.readFile(file);
  await audit(app.db, actor, 'prescription.viewed', 'prescription', rx.id, {});
  return data;
}

export async function reviewPrescription(
  app: App,
  id: string,
  decision: { status: 'approved' | 'rejected'; notes: string | null; doctorRegNo: string | null; validUntil: string | null },
  actor: Actor,
) {
  const settings = await app.settings.all();
  const rx = await getPrescription(app.db, id);
  if (!rx) throw new UserFacingError('Prescription not found.', 'not_found', 404);
  if (rx.status !== 'pending') throw new UserFacingError('This prescription has already been reviewed.');
  if (decision.status === 'rejected' && !decision.notes) throw new UserFacingError('Add a note explaining why the prescription was rejected.');
  const validUntil =
    decision.status === 'approved' ? (decision.validUntil ?? new Date(Date.now() + settings.pharmacy.rxValidityDays * 86_400_000).toISOString().slice(0, 10)) : null;
  await app.db.tx(async (t) => {
    await t.query(
      `UPDATE prescriptions SET status = $2, review_notes = $3, doctor_reg_no = coalesce($4, doctor_reg_no), valid_until = $5,
         reviewer_id = $6, reviewed_at = now() WHERE id = $1`,
      [id, decision.status, decision.notes, decision.doctorRegNo, validUntil, actor.id],
    );
    await audit(t, actor, `prescription.${decision.status}`, 'prescription', id, { notes: decision.notes });
  });
  await sendSafely(
    app.mailer,
    rx.customer_email,
    `Your prescription was ${decision.status}`,
    decision.status === 'approved'
      ? `Our pharmacist approved the prescription you uploaded (valid until ${validUntil}).`
      : `Our pharmacist could not approve the prescription you uploaded. Reason: ${decision.notes}`,
  );
}

/** Pharmacist decision on an order containing prescription items. */
export async function reviewRxOrder(app: App, orderId: string, decision: 'approved' | 'rejected', note: string | null, actor: Actor) {
  await app.db.tx(async (t) => {
    const o = await t.one<{ number: string; requires_rx_review: boolean; rx_review_status: string | null }>(
      'SELECT number, requires_rx_review, rx_review_status FROM orders WHERE id = $1 FOR UPDATE',
      [orderId],
    );
    if (!o || !o.requires_rx_review) throw new UserFacingError('This order does not need a prescription review.');
    if (o.rx_review_status !== 'pending') throw new UserFacingError('This order has already been reviewed.');
    await t.query(`UPDATE orders SET rx_review_status = $2, rx_reviewer_id = $3, updated_at = now() WHERE id = $1`, [orderId, decision, actor.id]);
    await t.query(`INSERT INTO order_events (order_id, status, note, actor_id) VALUES ($1, $2, $3, $4)`, [
      orderId,
      `rx_${decision}`,
      decision === 'approved' ? 'Pharmacist verified the prescription.' : `Pharmacist could not verify the prescription. ${note ?? ''}`.trim(),
      actor.id,
    ]);
    await audit(t, actor, `order.rx_${decision}`, 'order', orderId, { note, number: o.number });
  });
}

/** Deletes files and rows past their retention date (run daily). */
export async function purgeExpiredPrescriptions(app: App) {
  const due = await app.db.many<{ id: string; storage_key: string }>(`SELECT id, storage_key FROM prescriptions WHERE delete_after < current_date LIMIT 500`);
  for (const r of due) {
    await fs.rm(path.join(storageDir(app), path.basename(r.storage_key)), { force: true });
    await app.db.query(`UPDATE orders SET prescription_id = NULL WHERE prescription_id = $1`, [r.id]);
    await app.db.query('DELETE FROM prescriptions WHERE id = $1', [r.id]);
    await audit(app.db, { id: null, role: 'system' }, 'prescription.purged', 'prescription', r.id, {});
  }
  await app.db.query(`UPDATE prescriptions SET status = 'expired' WHERE status = 'approved' AND valid_until < current_date`);
  return due.length;
}
