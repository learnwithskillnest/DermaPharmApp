import { hmacHex, safeEqualHex, header, type PaymentProvider, type ProviderPayment, type WebhookEvent } from './provider.ts';

/**
 * Razorpay adapter (Orders API + Checkout + Webhooks).
 *
 * STATUS: written against Razorpay's public API documentation; NOT exercised
 * against Razorpay's test mode from the build sandbox (no network access or
 * credentials). Run the "Razorpay test-mode checklist" in DEPLOYMENT.md
 * before going live.
 *
 *  - Orders:   POST /v1/orders {amount, currency, receipt, notes}
 *  - Checkout: returns razorpay_order_id, razorpay_payment_id, razorpay_signature
 *              signature = HMAC_SHA256(key_secret, order_id + "|" + payment_id)
 *  - Payments: GET /v1/payments/:id  → { id, order_id, amount, status }
 *  - Webhook:  X-Razorpay-Signature = HMAC_SHA256(webhook_secret, raw body)
 *              X-Razorpay-Event-Id  = unique event id (dedupe key)
 *  - Refunds:  POST /v1/payments/:id/refund {amount, notes}
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay' as const;
  readonly isSandbox = false;
  private base = 'https://api.razorpay.com/v1';

  constructor(
    readonly keyId: string,
    private keySecret: string,
    private webhookSecret: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
    if (!res.ok) throw new Error(`Razorpay ${method} ${path} failed (${res.status}): ${data.error?.description ?? 'unknown error'}`);
    return data;
  }

  async createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }) {
    const order = await this.call<{ id: string }>('POST', '/orders', {
      amount: input.amountPaise,
      currency: 'INR',
      receipt: input.receipt.slice(0, 40),
      notes: input.notes,
    });
    return { providerOrderId: order.id };
  }

  verifyClientSignature(cb: { providerOrderId: string; providerPaymentId: string; signature: string }) {
    const expected = hmacHex(this.keySecret, `${cb.providerOrderId}|${cb.providerPaymentId}`);
    return safeEqualHex(expected, cb.signature);
  }

  async fetchPayment(id: string): Promise<ProviderPayment | null> {
    if (!/^pay_[A-Za-z0-9]+$/.test(id)) return null;
    const p = await this.call<{ id: string; order_id: string; amount: number; status: string }>('GET', `/payments/${id}`);
    const status = (['created', 'authorized', 'captured', 'failed', 'refunded'] as const).find((s) => s === p.status) ?? 'unknown';
    return { id: p.id, orderId: p.order_id, amountPaise: p.amount, status };
  }

  parseWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    const sig = header(headers, 'x-razorpay-signature');
    if (!sig || !safeEqualHex(hmacHex(this.webhookSecret, raw), sig)) return null;
    let body: {
      event?: string;
      created_at?: number;
      payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number; status?: string } } };
    };
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
    const type = body.event ?? 'unknown';
    const pay = body.payload?.payment?.entity;
    const eventId = header(headers, 'x-razorpay-event-id') || `${type}:${pay?.id ?? ''}:${body.created_at ?? ''}`;
    const outcome = type === 'payment.captured' || type === 'order.paid' ? 'captured' : type === 'payment.failed' ? 'failed' : 'ignored';
    return {
      eventId,
      type,
      outcome,
      providerOrderId: pay?.order_id ?? null,
      providerPaymentId: pay?.id ?? null,
      amountPaise: typeof pay?.amount === 'number' ? pay.amount : null,
      raw: { event: type, payment_id: pay?.id, order_id: pay?.order_id, amount: pay?.amount, status: pay?.status },
    };
  }

  async refund(paymentId: string, amountPaise: number, note: string) {
    const r = await this.call<{ id: string }>('POST', `/payments/${paymentId}/refund`, { amount: amountPaise, notes: { reason: note.slice(0, 200) } });
    return { refundId: r.id };
  }
}
