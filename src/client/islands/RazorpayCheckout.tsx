import { useState } from 'react';

export interface RazorpayCheckoutProps {
  keyId: string;
  providerOrderId: string;
  amountPaise: number;
  orderNumber: string;
  storeName: string;
  prefill: { name: string; email: string; contact: string };
  csrf: string;
}

interface RazorpayResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

declare global {
  interface Window {
    Razorpay?: new (opts: unknown) => { open(): void; on(ev: string, cb: (r: unknown) => void): void };
  }
}

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve();
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the payment window.'));
    document.head.appendChild(s);
  });
}

/** Posts Razorpay's signed result to our server, which verifies it before confirming. */
function postResult(csrf: string, orderNumber: string, r: RazorpayResponse) {
  const f = document.createElement('form');
  f.method = 'post';
  f.action = '/checkout/callback';
  const fields: Record<string, string> = {
    _csrf: csrf,
    order_number: orderNumber,
    provider_order_id: r.razorpay_order_id,
    provider_payment_id: r.razorpay_payment_id,
    signature: r.razorpay_signature,
  };
  for (const [k, v] of Object.entries(fields)) {
    const i = document.createElement('input');
    i.type = 'hidden';
    i.name = k;
    i.value = v;
    f.appendChild(i);
  }
  document.body.appendChild(f);
  f.submit();
}

export function RazorpayCheckout(p: RazorpayCheckoutProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function pay() {
    setBusy(true);
    setError(null);
    try {
      await loadScript();
      const rzp = new window.Razorpay!({
        key: p.keyId,
        order_id: p.providerOrderId,
        amount: p.amountPaise,
        currency: 'INR',
        name: p.storeName,
        description: `Order ${p.orderNumber}`,
        prefill: p.prefill,
        handler: (r: RazorpayResponse) => postResult(p.csrf, p.orderNumber, r),
        modal: { ondismiss: () => setBusy(false) },
        theme: { color: '#163a2d' },
      });
      rzp.on('payment.failed', () => setError('The payment did not go through. You can try again or choose another method.'));
      rzp.open();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-3">
      <button type="button" className="btn btn-primary btn-block" onClick={pay} disabled={busy}>
        {busy ? 'Opening secure payment…' : 'Pay securely with Razorpay'}
      </button>
      <div aria-live="polite">{error ? <p className="error-text">{error}</p> : null}</div>
      <noscript>
        <p className="notice notice-warning">Online payment needs JavaScript. Enable it, or go back and choose cash on delivery if available.</p>
      </noscript>
    </div>
  );
}
