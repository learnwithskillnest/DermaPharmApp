import { z } from 'zod';
import { rupeesToPaise } from '../shared/money.ts';

export type FieldErrors = Record<string, string>;
export type FormResult<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors };

export function parseWith<S extends z.ZodTypeAny>(schema: S, input: unknown): FormResult<z.infer<S>> {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, data: r.data };
  const errors: FieldErrors = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '_form';
    if (!errors[key]) errors[key] = issue.message;
  }
  return { ok: false, errors };
}

// ───── primitives ─────
const trimmed = (max: number) => z.string().trim().max(max, `Use at most ${max} characters.`);
const required = (label: string, max = 200) => trimmed(max).min(1, `Enter ${label}.`);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Use at most ${max} characters.`)
    .optional()
    .transform((v) => (v ? v : null));

export const emailField = z.string().trim().toLowerCase().max(254).email('Enter a valid email address.');
export const phoneField = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s()-]/g, '').replace(/^(\+91|91|0)(?=\d{10}$)/, ''))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number.'));
export const pincodeField = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code.');
export const checkbox = z
  .union([z.literal('on'), z.literal('true'), z.literal('1'), z.literal('')])
  .optional()
  .transform((v) => v === 'on' || v === 'true' || v === '1');
export const uuidField = z.string().uuid('Invalid reference.');
export const slugField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and single hyphens.')
  .max(120);
export const rupeesField = (label: string) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      const p = rupeesToPaise(v);
      if (p === null || p <= 0) {
        ctx.addIssue({ code: 'custom', message: `Enter ${label} in rupees, e.g. 499 or 499.50.` });
        return z.NEVER;
      }
      return p;
    });
export const intField = (label: string, min: number, max: number) =>
  z.coerce
    .number({ invalid_type_error: `Enter ${label} as a number.` })
    .int(`Enter ${label} as a whole number.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} must be at most ${max}.`);
export const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the date picker (YYYY-MM-DD).');

export const INDIAN_STATES = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;

// ───── customer forms ─────
export const registerSchema = z
  .object({
    name: required('your name', 80),
    email: emailField,
    phone: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || undefined)
      .pipe(phoneField.optional()),
    password: z.string().min(1, 'Choose a password.').max(200),
    confirm: z.string(),
    terms: checkbox.refine((v) => v, 'Accept the terms and privacy policy to create an account.'),
    marketing: checkbox,
  })
  .refine((d) => d.password === d.confirm, { path: ['confirm'], message: 'Passwords do not match.' });

export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, 'Enter your password.').max(200),
});

export const forgotSchema = z.object({ email: emailField });
export const resetSchema = z
  .object({ token: z.string().min(20).max(100), password: z.string().min(1, 'Choose a password.').max(200), confirm: z.string() })
  .refine((d) => d.password === d.confirm, { path: ['confirm'], message: 'Passwords do not match.' });

export const profileSchema = z.object({
  name: required('your name', 80),
  phone: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined)
    .pipe(phoneField.optional()),
  marketing: checkbox,
});

export const changePasswordSchema = z
  .object({ current: z.string().min(1, 'Enter your current password.'), password: z.string().min(1, 'Choose a new password.').max(200), confirm: z.string() })
  .refine((d) => d.password === d.confirm, { path: ['confirm'], message: 'Passwords do not match.' });

export const addressSchema = z.object({
  label: optionalText(30),
  fullName: required('the recipient name', 80),
  phone: phoneField,
  line1: required('the house / flat and street', 120),
  line2: optionalText(120),
  landmark: optionalText(80),
  city: required('the city', 60),
  state: z.enum(INDIAN_STATES, { errorMap: () => ({ message: 'Choose a state or union territory.' }) }),
  pincode: pincodeField,
  isDefault: checkbox,
});

export const contactSchema = z.object({
  name: required('your name', 80),
  email: emailField,
  phone: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined)
    .pipe(phoneField.optional()),
  topic: z.enum(['order', 'product', 'returns', 'pharmacy', 'privacy', 'other'], { errorMap: () => ({ message: 'Choose a topic.' }) }),
  orderNumber: optionalText(30),
  message: required('your message', 3000).refine((v) => v.length >= 10, 'Tell us a little more (10+ characters).'),
});

export const cartAddSchema = z.object({
  variantId: uuidField,
  quantity: z.coerce.number().int('Quantity must be a whole number.').min(1, 'Quantity must be at least 1.').max(20, 'You can add at most 20 of an item.'),
});
export const cartUpdateSchema = z.object({
  variantId: uuidField,
  quantity: z.coerce.number().int('Quantity must be a whole number.').min(0, 'Quantity cannot be negative.').max(20, 'You can buy at most 20 of an item.'),
});
export const couponSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .min(1, 'Enter a coupon code.')
    .max(30)
    .regex(/^[A-Z0-9_-]+$/, 'Coupon codes use letters and numbers only.'),
});

export const placeOrderSchema = z.object({
  addressId: uuidField.or(z.literal('')).refine((v) => v !== '', 'Choose a delivery address.'),
  paymentMethod: z.enum(['online', 'cod'], { errorMap: () => ({ message: 'Choose a payment method.' }) }),
  prescriptionId: z
    .string()
    .uuid()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  note: optionalText(300),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Reload the checkout page and try again.'),
  acceptTerms: checkbox.refine((v) => v, 'Confirm you have reviewed your order and accept the terms.'),
});

export const rxUploadSchema = z.object({
  patientName: required('the patient name', 80),
  doctorName: optionalText(80),
  issuedOn: z
    .string()
    .optional()
    .transform((v) => v || null)
    .pipe(dateField.nullable()),
  consent: checkbox.refine((v) => v, 'Confirm consent so our pharmacist can review this prescription.'),
});

export const returnRequestSchema = z.object({
  reason: z.enum(['damaged', 'wrong_item', 'expired', 'not_as_described', 'sealed_unopened', 'other'], { errorMap: () => ({ message: 'Choose a reason.' }) }),
  details: optionalText(1000),
});

export const trackSchema = z.object({
  number: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^GD-\d{4,10}$/, 'Order numbers look like GD-1001.'),
  email: emailField,
});
