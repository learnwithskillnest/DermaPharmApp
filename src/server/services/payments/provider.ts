import crypto from 'node:crypto';

/** Status as reported BY THE PROVIDER (server-to-server), never by the browser. */
export type ProviderPaymentStatus = 'created' | 'authorized' | 'captured' | 'failed' | 'refunded' | 'unknown';

export interface ProviderPayment {
  id: string;
  orderId: string;
  amountPaise: number;
  status: ProviderPaymentStatus;
}

export interface WebhookEvent {
  eventId: string;
  type: string;
  /** Normalised outcome for our state machine. */
  outcome: 'captured' | 'failed' | 'ignored';
  providerOrderId: string | null;
  providerPaymentId: string | null;
  amountPaise: number | null;
  raw: unknown;
}

export interface ClientCallback {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

export interface PaymentProvider {
  readonly name: 'sandbox' | 'razorpay';
  readonly isSandbox: boolean;
  createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<{ providerOrderId: string }>;
  /** Verifies the signed parameters the checkout returns to the browser. */
  verifyClientSignature(cb: ClientCallback): boolean;
  /** Authoritative server-to-server lookup. */
  fetchPayment(providerPaymentId: string): Promise<ProviderPayment | null>;
  /** Verifies a webhook's signature over the exact raw body and parses it. Returns null if invalid. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null;
  refund(providerPaymentId: string, amountPaise: number, note: string): Promise<{ refundId: string }>;
}

export function hmacHex(secret: string, data: string | Buffer) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function header(h: Record<string, string | string[] | undefined>, name: string): string {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}
