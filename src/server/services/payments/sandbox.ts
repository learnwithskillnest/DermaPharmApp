import crypto from 'node:crypto';
import type { Queryable } from '../../db/db.ts';
import { hmacHex, safeEqualHex, header, type PaymentProvider, type ProviderPayment, type WebhookEvent } from './provider.ts';

/**
 * Built-in SANDBOX gateway — moves no money. It mimics a real provider's
 * contract (signed callback + signed webhook + server-side status lookup) so
 * the order pipeline is exercised exactly as it will be with Razorpay.
 *
 * The provider's "own records" are the `sandbox_payments` table; the gateway
 * page at /sandbox-gateway/:id plays the role of the hosted checkout.
 */
export class SandboxProvider implements PaymentProvider {
  readonly name = 'sandbox' as const;
  readonly isSandbox = true;

  constructor(
    private db: Queryable,
    private secret: string,
  ) {}

  async createOrder(input: { amountPaise: number; receipt: string }) {
    const id = 'sbx_order_' + crypto.randomBytes(9).toString('base64url');
    await this.db.query('INSERT INTO sandbox_payments (provider_order_id, amount_paise) VALUES ($1, $2)', [id, input.amountPaise]);
    void input.receipt;
    return { providerOrderId: id };
  }

  /** Called by the sandbox gateway page when the tester chooses an outcome. */
  async complete(providerOrderId: string, outcome: 'captured' | 'failed') {
    const paymentId = 'sbx_pay_' + crypto.randomBytes(9).toString('base64url');
    const row = await this.db.one<{ amount_paise: number }>(
      `UPDATE sandbox_payments SET status = $2, provider_payment_id = $3, updated_at = now()
        WHERE provider_order_id = $1 AND status = 'created' RETURNING amount_paise`,
      [providerOrderId, outcome, paymentId],
    );
    if (!row) return null;
    return {
      paymentId,
      amountPaise: row.amount_paise,
      signature: this.sign(providerOrderId, paymentId),
    };
  }

  sign(orderId: string, paymentId: string) {
    return hmacHex(this.secret, `${orderId}|${paymentId}`);
  }

  /** Builds a signed webhook exactly as the gateway would send it. */
  buildWebhook(event: { type: 'payment.captured' | 'payment.failed'; orderId: string; paymentId: string; amountPaise: number }) {
    const body = Buffer.from(
      JSON.stringify({
        event: event.type,
        payload: {
          payment: { entity: { id: event.paymentId, order_id: event.orderId, amount: event.amountPaise, status: event.type === 'payment.captured' ? 'captured' : 'failed' } },
        },
      }),
    );
    return {
      body,
      headers: { 'x-sandbox-signature': hmacHex(this.secret + ':webhook', body), 'x-sandbox-event-id': 'evt_' + crypto.randomBytes(9).toString('base64url') },
    };
  }

  verifyClientSignature(cb: { providerOrderId: string; providerPaymentId: string; signature: string }) {
    return safeEqualHex(this.sign(cb.providerOrderId, cb.providerPaymentId), cb.signature);
  }

  async fetchPayment(id: string): Promise<ProviderPayment | null> {
    const r = await this.db.one<{ provider_order_id: string; amount_paise: number; status: string }>(
      'SELECT provider_order_id, amount_paise, status FROM sandbox_payments WHERE provider_payment_id = $1',
      [id],
    );
    if (!r) return null;
    const status = r.status === 'captured' ? 'captured' : r.status === 'failed' ? 'failed' : r.status === 'refunded' ? 'refunded' : 'created';
    return { id, orderId: r.provider_order_id, amountPaise: r.amount_paise, status };
  }

  parseWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): WebhookEvent | null {
    const sig = header(headers, 'x-sandbox-signature');
    if (!sig || !safeEqualHex(hmacHex(this.secret + ':webhook', raw), sig)) return null;
    let body: { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number } } } };
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return null;
    }
    const pay = body.payload?.payment?.entity;
    const type = body.event ?? 'unknown';
    return {
      eventId: header(headers, 'x-sandbox-event-id') || `${type}:${pay?.id}`,
      type,
      outcome: type === 'payment.captured' ? 'captured' : type === 'payment.failed' ? 'failed' : 'ignored',
      providerOrderId: pay?.order_id ?? null,
      providerPaymentId: pay?.id ?? null,
      amountPaise: pay?.amount ?? null,
      raw: body,
    };
  }

  async refund(paymentId: string, amountPaise: number) {
    await this.db.query(`UPDATE sandbox_payments SET status = 'refunded', updated_at = now() WHERE provider_payment_id = $1`, [paymentId]);
    void amountPaise;
    return { refundId: 'sbx_rfnd_' + crypto.randomBytes(9).toString('base64url') };
  }
}
