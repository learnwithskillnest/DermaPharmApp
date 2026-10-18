import { z } from 'zod';
import { asJson, type Queryable } from '../db/db.ts';
import type { Config } from '../config.ts';

/**
 * Store settings live in the `settings` table (one JSON value per group) so
 * admins can change them without a deploy. Defaults below are PLACEHOLDERS —
 * every regulatory/commercial value must be confirmed by the business.
 */
export const settingsSchema = {
  store: z.object({
    name: z.string().min(1).max(80),
    legalName: z.string().max(160),
    email: z.string().email().or(z.literal('')),
    phone: z.string().max(30),
    address: z.string().max(400),
    gstin: z.string().max(20),
    supportHours: z.string().max(120),
  }),
  shipping: z.object({
    flatFeePaise: z.number().int().min(0).max(1_000_000),
    freeThresholdPaise: z.number().int().min(0).max(100_000_000),
    codEnabled: z.boolean(),
    codFeePaise: z.number().int().min(0).max(100_000),
    codMaxOrderPaise: z.number().int().min(0).max(100_000_000),
    blockedPincodePrefixes: z.array(z.string().regex(/^[1-9][0-9]{0,5}$/)).max(500),
    dispatchTime: z.string().max(80),
    deliveryEstimate: z.string().max(80),
  }),
  pharmacy: z.object({
    otcVisible: z.boolean(),
    rxListingVisible: z.boolean(),
    rxOrderingEnabled: z.boolean(),
    drugLicenceNumbers: z.string().max(300),
    pharmacistName: z.string().max(120),
    pharmacistRegNo: z.string().max(60),
    rxValidityDays: z.number().int().min(1).max(730),
    rxRetentionDays: z.number().int().min(30).max(3650),
  }),
  compliance: z.object({
    grievanceOfficerName: z.string().max(120),
    grievanceOfficerEmail: z.string().email().or(z.literal('')),
    grievanceOfficerPhone: z.string().max(30),
    cin: z.string().max(30),
  }),
  orders: z.object({
    returnWindowDays: z.number().int().min(0).max(60),
    reservationMinutes: z.number().int().min(5).max(240),
  }),
};

export type Settings = { [K in keyof typeof settingsSchema]: z.infer<(typeof settingsSchema)[K]> };
export type SettingsGroup = keyof Settings;

export const DEFAULT_SETTINGS: Settings = {
  store: {
    name: 'GlowDerma Store',
    legalName: '[Legal entity name — to be provided]',
    email: '',
    phone: '[Support phone — to be provided]',
    address: '[Registered address — to be provided]',
    gstin: '',
    supportHours: 'Mon–Sat, 10:00–18:00 IST',
  },
  shipping: {
    flatFeePaise: 4900,
    freeThresholdPaise: 49900,
    codEnabled: true,
    codFeePaise: 3000,
    codMaxOrderPaise: 500000,
    blockedPincodePrefixes: [],
    dispatchTime: '1–2 business days',
    deliveryEstimate: '3–7 business days',
  },
  pharmacy: {
    otcVisible: true,
    rxListingVisible: true,
    rxOrderingEnabled: false,
    drugLicenceNumbers: '',
    pharmacistName: '',
    pharmacistRegNo: '',
    rxValidityDays: 180,
    rxRetentionDays: 1095,
  },
  compliance: {
    grievanceOfficerName: '',
    grievanceOfficerEmail: '',
    grievanceOfficerPhone: '',
    cin: '',
  },
  orders: {
    returnWindowDays: 7,
    reservationMinutes: 30,
  },
};

export class SettingsService {
  private cache: { value: Settings; at: number } | null = null;
  constructor(
    private db: Queryable,
    private config: Config,
  ) {}

  async all(): Promise<Settings> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.value;
    const rows = await this.db.many<{ key: string; value: unknown }>('SELECT key, value FROM settings');
    const merged = structuredClone(DEFAULT_SETTINGS) as Record<string, Record<string, unknown>>;
    for (const r of rows) {
      if (r.key in merged && r.value && typeof r.value === 'object') Object.assign(merged[r.key], r.value);
    }
    this.cache = { value: merged as unknown as Settings, at: Date.now() };
    return this.cache.value;
  }

  async update<K extends SettingsGroup>(group: K, value: Settings[K], actorId: string | null) {
    const parsed = settingsSchema[group].parse(value);
    await this.db.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [group, asJson(parsed), actorId],
    );
    this.cache = null;
  }

  invalidate() {
    this.cache = null;
  }

  /** Every reason prescription ordering is currently blocked (empty = allowed). */
  async rxOrderingBlockers(): Promise<string[]> {
    const s = await this.all();
    const out: string[] = [];
    if (!this.config.ENABLE_PRESCRIPTION_ORDERING) out.push('Server flag ENABLE_PRESCRIPTION_ORDERING is not set to true.');
    if (!s.pharmacy.rxOrderingEnabled) out.push('Prescription ordering is switched off in store settings.');
    if (!s.pharmacy.drugLicenceNumbers.trim()) out.push('Drug sale licence number(s) are not recorded.');
    if (!s.pharmacy.pharmacistName.trim() || !s.pharmacy.pharmacistRegNo.trim()) out.push('Registered pharmacist name and registration number are not recorded.');
    return out;
  }

  async rxOrderingEnabled() {
    return (await this.rxOrderingBlockers()).length === 0;
  }
}
