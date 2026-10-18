import type { ReactNode } from 'react';
import { Breadcrumbs, MedicalNote } from '../layout.tsx';
import { Form, FormErrors, SelectField, TextArea, TextField, type Errors, type Values } from '../forms.tsx';
import type { Settings } from '../../server/services/settings.ts';
import { formatINR } from '../../shared/money.ts';

export function ErrorPage({ status, title, message }: { status: number; title: string; message: string }) {
  return (
    <div className="wrap py-20">
      <p className="tabular text-sm font-semibold text-[var(--color-champagne-700)]">Error {status}</p>
      <h1 className="mt-2 text-3xl md:text-4xl">{title}</h1>
      <p className="mt-3 max-w-xl text-lg text-[var(--color-muted)]">{message}</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <a href="/" className="btn btn-primary">
          Go to the homepage
        </a>
        {status === 401 || status === 403 ? (
          <a href="/login" className="btn btn-secondary">
            Sign in
          </a>
        ) : (
          <a href="/shop" className="btn btn-secondary">
            Browse products
          </a>
        )}
      </div>
    </div>
  );
}

/** Banner on every policy page: these are drafts until a lawyer reviews them. */
function DraftBanner() {
  return (
    <div className="notice notice-warning mb-8" role="note">
      <strong>Draft policy text.</strong> This page was written as a starting template and must be reviewed by a qualified Indian legal professional before launch. Items in [square
      brackets] are placeholders.
    </div>
  );
}

export function InfoPage({ title, crumbs, children, draft = true, intro }: { title: string; crumbs?: string; children: ReactNode; draft?: boolean; intro?: string }) {
  return (
    <div className="wrap py-8 md:py-12">
      <Breadcrumbs items={[{ href: '/', label: 'Home' }, { label: crumbs ?? title }]} />
      <h1 className="mt-4 text-3xl md:text-4xl">{title}</h1>
      {intro ? <p className="mt-3 max-w-2xl text-lg text-[var(--color-muted)]">{intro}</p> : null}
      <div className="mt-8">
        {draft ? <DraftBanner /> : null}
        <div className="prose-gd">{children}</div>
      </div>
    </div>
  );
}

export function ShippingPolicy({ s }: { s: Settings }) {
  return (
    <InfoPage title="Shipping policy">
      <h2>Where we deliver</h2>
      <p>We deliver to serviceable PIN codes across India. Checkout tells you if your PIN code is not serviceable before you pay.</p>
      <h2>Charges</h2>
      <ul>
        <li>Orders of {formatINR(s.shipping.freeThresholdPaise)} or more (after discounts) ship free.</li>
        <li>Smaller orders have a flat delivery charge of {formatINR(s.shipping.flatFeePaise)}.</li>
        {s.shipping.codEnabled ? (
          <li>
            Cash on delivery carries a handling fee of {formatINR(s.shipping.codFeePaise)} and is available for orders up to {formatINR(s.shipping.codMaxOrderPaise)}.
          </li>
        ) : (
          <li>Cash on delivery is currently unavailable.</li>
        )}
      </ul>
      <h2>Timelines</h2>
      <p>
        Orders are usually dispatched within {s.shipping.dispatchTime} and delivered in {s.shipping.deliveryEstimate}, depending on your location. Orders containing prescription
        medicines are dispatched only after our registered pharmacist verifies the prescription.
      </p>
      <h2>Product handling</h2>
      <p>
        Temperature-sensitive products are packed to protect them in transit. We dispatch products with adequate remaining shelf life; the expiry date is printed on every pack.
      </p>
      <h2>Tracking</h2>
      <p>
        You receive a tracking number once your order ships. You can follow it from <a href="/account/orders">your orders</a> or <a href="/track">track an order</a>.
      </p>
    </InfoPage>
  );
}

export function ReturnsPolicy({ s }: { s: Settings }) {
  return (
    <InfoPage title="Returns & refunds">
      <h2>Return window</h2>
      <p>You can request a return within {s.orders.returnWindowDays} days of delivery from the order page in your account.</p>
      <h2>What can be returned</h2>
      <ul>
        <li>Items that arrived damaged, leaking, expired or different from what you ordered.</li>
        <li>Sealed, unopened skincare and personal-care items (for hygiene reasons, opened products can't be returned unless defective).</li>
        <li>Medicines can be returned only if damaged, expired or incorrect, in line with pharmacy regulations.</li>
      </ul>
      <h2>Cancellations</h2>
      <p>You can cancel an order yourself until it is packed. After that, you can ask us to cancel and we will confirm whether it can be stopped.</p>
      <h2>Refunds</h2>
      <ul>
        <li>
          Online payments are refunded to the original payment method once the return is approved or the cancellation is confirmed. Banks usually take 5–7 business days to show the
          credit.
        </li>
        <li>Cash-on-delivery refunds are made by bank transfer to an account you provide. [Process to be confirmed.]</li>
        <li>You can see the status of every refund on your order page.</li>
      </ul>
    </InfoPage>
  );
}

export function PrivacyPolicy({ s }: { s: Settings }) {
  return (
    <InfoPage title="Privacy policy">
      <p>
        This policy explains how {s.store.legalName} (“we”) collects and uses personal data when you use {s.store.name}. It is intended to meet the Digital Personal Data Protection
        Act, 2023 and related rules. [Legal review required.]
      </p>
      <h2>What we collect and why</h2>
      <ul>
        <li>
          <strong>Account details</strong> (name, email, phone) to run your account and send order updates.
        </li>
        <li>
          <strong>Delivery addresses</strong> to ship orders.
        </li>
        <li>
          <strong>Order and payment records</strong> to fulfil orders and meet tax obligations. We never see or store your card details; payments are handled by our payment
          provider.
        </li>
        <li>
          <strong>Prescriptions</strong>, only if you upload them, so a registered pharmacist can verify prescription orders. They are stored privately, seen only by pharmacists,
          and deleted after [{s.pharmacy.rxRetentionDays} days — retention period to be confirmed against applicable record-keeping rules].
        </li>
        <li>
          <strong>Technical data</strong> (IP address, browser) to keep the site secure and prevent abuse.
        </li>
      </ul>
      <h2>What we don't do</h2>
      <ul>
        <li>We don't sell your personal data.</li>
        <li>Analytics are switched off unless we tell you otherwise and ask for consent.</li>
      </ul>
      <h2>Your rights</h2>
      <p>
        You can access and correct your data in your account, and delete your account from <a href="/account/settings">Profile & security</a>. Order records may be kept where the
        law requires (for example, tax invoices). For other requests, contact our grievance officer listed on <a href="/seller-information#grievance">seller information</a>.
      </p>
      <h2>Cookies</h2>
      <p>We use essential cookies only: one to keep you signed in and your cart, and one short-lived cookie for on-screen messages.</p>
    </InfoPage>
  );
}

export function TermsPage({ s }: { s: Settings }) {
  return (
    <InfoPage title="Terms of use">
      <p>
        These terms govern your use of {s.store.name}, operated by {s.store.legalName}, {s.store.address}. [Legal review required.]
      </p>
      <h2>Products and information</h2>
      <p>
        Product descriptions, ingredients and directions are provided for general information. They are not medical advice, a diagnosis or a recommendation for your individual
        condition. Always read the label and consult a doctor or pharmacist about medical concerns.
      </p>
      <h2>Prescription medicines</h2>
      <p>
        Prescription medicines are supplied only against a valid prescription from a registered medical practitioner, verified by our registered pharmacist, and only where we hold
        the licences required by law. Online ordering of prescription medicines may be unavailable.
      </p>
      <h2>Prices and orders</h2>
      <p>
        Prices are in Indian rupees and include GST. An order is accepted when we confirm it after payment (or, for cash on delivery, after placing it). We may cancel an order if a
        product is unavailable, the price was clearly shown in error, or a prescription can't be verified; any payment is refunded in full.
      </p>
      <h2>Your account</h2>
      <p>Keep your password private. You are responsible for activity on your account. We may suspend accounts used for fraud or abuse.</p>
      <h2>Grievances</h2>
      <p>
        Complaints are handled by our grievance officer (see <a href="/seller-information#grievance">seller information</a>), who will acknowledge them within 48 hours and aim to
        resolve them within one month, as required by the Consumer Protection (E-Commerce) Rules, 2020.
      </p>
    </InfoPage>
  );
}

export function ProductSafetyPage() {
  return (
    <InfoPage title="Product safety information" intro="How to use skincare and pharmacy products safely, and what to do if something goes wrong.">
      <MedicalNote />
      <h2>Before you start</h2>
      <ul>
        <li>Read the full ingredient list and warnings on the product page and the pack.</li>
        <li>Patch-test new skincare on a small area (for example, behind the ear) for 24–48 hours.</li>
        <li>Introduce one new active ingredient at a time.</li>
      </ul>
      <h2>Actives that need extra care</h2>
      <ul>
        <li>
          <strong>Exfoliating acids</strong> (salicylic, glycolic, lactic, azelaic acid) can cause dryness or stinging. Use sunscreen daily while using them.
        </li>
        <li>
          <strong>Vitamin C and retinoids</strong> can irritate sensitive skin; follow the directions on the pack.
        </li>
        <li>If you are pregnant, breastfeeding, or using prescription treatments, ask your doctor before using new actives.</li>
      </ul>
      <h2>If you have a reaction</h2>
      <p>Stop using the product, rinse with water, and seek medical advice if redness, swelling, blistering or breathing difficulty occurs. In an emergency, call 112.</p>
      <h2>Medicines</h2>
      <ul>
        <li>Use medicines only as directed on the label or by your doctor. Don't share prescription medicines.</li>
        <li>Check the expiry date and storage conditions on arrival.</li>
        <li>Report suspected adverse drug reactions to your doctor or through the Pharmacovigilance Programme of India (PvPI). [Add current PvPI contact details.]</li>
      </ul>
      <h2>Tell us</h2>
      <p>
        If a product you bought from us seems faulty or caused a reaction, <a href="/contact">contact us</a> with your order number so we can investigate the batch.
      </p>
    </InfoPage>
  );
}

export function SellerInfoPage({ s, rxBlockers }: { s: Settings; rxBlockers: string[] }) {
  const v = (x: string) => (x.trim() ? x : '[Not yet provided]');
  return (
    <InfoPage title="Seller & licence details" intro="Information we are required to show as an e-commerce seller in India.">
      <h2>Seller</h2>
      <ul>
        <li>Legal name: {v(s.store.legalName)}</li>
        <li>Registered address: {v(s.store.address)}</li>
        <li>GSTIN: {v(s.store.gstin)}</li>
        <li>CIN: {v(s.compliance.cin)}</li>
        <li>
          Customer support: {v(s.store.phone)} {s.store.email ? `, ${s.store.email}` : ''} ({s.store.supportHours})
        </li>
      </ul>
      <h2>Pharmacy</h2>
      <ul>
        <li>Drug sale licence number(s): {v(s.pharmacy.drugLicenceNumbers)}</li>
        <li>
          Registered pharmacist: {v(s.pharmacy.pharmacistName)}
          {s.pharmacy.pharmacistRegNo ? ` (Reg. No. ${s.pharmacy.pharmacistRegNo})` : ''}
        </li>
        <li>Online prescription ordering: {rxBlockers.length ? 'not currently available' : 'available, subject to pharmacist verification'}</li>
      </ul>
      <h2 id="grievance">Grievance officer</h2>
      <ul>
        <li>Name: {v(s.compliance.grievanceOfficerName)}</li>
        <li>Email: {v(s.compliance.grievanceOfficerEmail)}</li>
        <li>Phone: {v(s.compliance.grievanceOfficerPhone)}</li>
      </ul>
      <p>We acknowledge complaints within 48 hours and aim to resolve them within one month.</p>
    </InfoPage>
  );
}

const FAQS: Array<[string, ReactNode]> = [
  [
    'Are the products on this demo store real?',
    'No. Every brand, product, price and image here is sample data created for demonstration. Payments run in sandbox mode, so nothing is charged or shipped.',
  ],
  ['Are your prices inclusive of GST?', 'Yes. Every price includes GST. Your invoice shows the tax component separately.'],
  [
    'How much is delivery?',
    <>
      Delivery is free above a minimum order value; smaller orders have a flat charge. See the <a href="/policies/shipping">shipping policy</a>.
    </>,
  ],
  [
    'Can I order prescription medicines?',
    'Prescription medicines are listed for information, but online ordering is switched off until our licences and pharmacist verification process are in place. Please buy them from a local pharmacy against your prescription.',
  ],
  [
    'Can you recommend a product for my skin condition?',
    'We can explain what is in a product and how to use it, but we can’t diagnose conditions or recommend treatment. Please consult a dermatologist or doctor.',
  ],
  ['How do I cancel an order?', 'Open the order in your account and choose “Cancel order”. Orders can be cancelled instantly until they are packed.'],
  [
    'How do returns work?',
    <>
      Request a return from the order page within the return window. See <a href="/policies/returns">returns & refunds</a>.
    </>,
  ],
  ['Is my payment information safe?', 'Card and UPI details are entered on the payment provider’s secure page. We never receive or store them.'],
];

export function FaqPage() {
  return (
    <InfoPage title="Frequently asked questions" crumbs="FAQs" draft={false}>
      <div className="not-prose grid gap-3">
        {FAQS.map(([q, a], i) => (
          <details key={i} className="rounded-xl border border-[var(--color-line)] px-5 py-4 open:bg-[var(--color-mint-50)]">
            <summary className="cursor-pointer font-semibold text-[var(--color-forest-900)]">{q}</summary>
            <div className="mt-2 text-[var(--color-ink)]">{a}</div>
          </details>
        ))}
      </div>
    </InfoPage>
  );
}

export const CONTACT_TOPICS = [
  { value: 'order', label: 'An existing order' },
  { value: 'product', label: 'A product question' },
  { value: 'returns', label: 'Returns or refunds' },
  { value: 'pharmacy', label: 'Pharmacy or prescriptions' },
  { value: 'privacy', label: 'Privacy or my data' },
  { value: 'other', label: 'Something else' },
];

export function ContactPage({ s, errors, values, sent }: { s: Settings; errors?: Errors; values?: Values; sent?: boolean }) {
  return (
    <div className="wrap grid gap-10 py-8 md:grid-cols-[1fr_20rem] md:py-12">
      <div>
        <Breadcrumbs items={[{ href: '/', label: 'Home' }, { label: 'Contact' }]} />
        <h1 className="mt-4 text-3xl md:text-4xl">Contact us</h1>
        <p className="mt-3 max-w-xl text-[var(--color-muted)]">We reply within one business day. For a medical emergency, call 112 — we can’t give medical advice.</p>
        {sent ? (
          <div className="notice notice-success mt-8" role="status">
            Thanks — your message is with our team. We will reply by email.
          </div>
        ) : (
          <Form action="/contact" className="mt-8 grid max-w-xl gap-5" ariaLabel="Contact form">
            <FormErrors errors={errors} />
            <TextField name="name" label="Your name" required autoComplete="name" value={values?.name} errors={errors} maxLength={80} />
            <TextField name="email" label="Email" type="email" required autoComplete="email" value={values?.email} errors={errors} />
            <TextField name="phone" label="Mobile number" type="tel" autoComplete="tel" inputMode="tel" value={values?.phone} errors={errors} />
            <SelectField name="topic" label="What is it about?" required options={CONTACT_TOPICS} placeholder="Choose a topic" value={values?.topic} errors={errors} />
            <TextField name="orderNumber" label="Order number" value={values?.orderNumber} errors={errors} placeholder="GD-1001" />
            <TextArea
              name="message"
              label="Message"
              required
              rows={6}
              maxLength={3000}
              value={values?.message}
              errors={errors}
              hint="Please don't include card numbers or passwords."
            />
            <div>
              <button type="submit" className="btn btn-primary">
                Send message
              </button>
            </div>
          </Form>
        )}
      </div>
      <aside className="grid content-start gap-4 rounded-2xl bg-[var(--color-mint-50)] p-6 text-sm">
        <h2 className="text-lg">Other ways to reach us</h2>
        <p>
          Phone: {s.store.phone}
          <br />
          Hours: {s.store.supportHours}
        </p>
        <p>{s.store.address}</p>
        <p>
          Complaints:{' '}
          <a className="link" href="/seller-information#grievance">
            grievance officer
          </a>
        </p>
      </aside>
    </div>
  );
}

export interface TrackResult {
  number: string;
  statusLabel: string;
  placed: string;
  events: Array<{ when: string; note: string }>;
  shipments: Array<{ carrier: string; tracking: string }>;
}

export function TrackPage({ errors, values, result }: { errors?: Errors; values?: Values; result?: TrackResult }) {
  if (result) {
    return (
      <div className="wrap max-w-xl py-8 md:py-12">
        <Breadcrumbs items={[{ href: '/', label: 'Home' }, { href: '/track', label: 'Track an order' }, { label: result.number }]} />
        <h1 className="mt-4 text-3xl">Order {result.number}</h1>
        <p className="mt-2 text-lg">
          Status: <strong className="text-[var(--color-forest-900)]">{result.statusLabel}</strong>
        </p>
        <p className="text-sm text-[var(--color-muted)]">Placed {result.placed}</p>
        {result.shipments.map((sh) => (
          <p key={sh.tracking} className="mt-3 text-sm">
            Shipped with {sh.carrier}, tracking number <span className="tabular font-semibold">{sh.tracking}</span>
          </p>
        ))}
        <ol className="mt-6 grid gap-3 border-l-2 border-[var(--color-mint-200)] pl-5">
          {result.events.map((e, i) => (
            <li key={i} className="text-sm">
              <span className="block text-xs text-[var(--color-muted)]">{e.when}</span>
              {e.note}
            </li>
          ))}
        </ol>
        <p className="mt-8 text-sm">
          <a className="link" href={`/login?next=/account/orders/${result.number}`}>
            Sign in
          </a>{' '}
          to cancel, request a return or see refund details.
        </p>
      </div>
    );
  }
  return (
    <div className="wrap max-w-xl py-8 md:py-12">
      <Breadcrumbs items={[{ href: '/', label: 'Home' }, { label: 'Track an order' }]} />
      <h1 className="mt-4 text-3xl">Track an order</h1>
      <p className="mt-2 text-[var(--color-muted)]">Enter your order number and the email used to place it. Signed in? Your orders are in your account.</p>
      <Form action="/track" className="mt-8 grid gap-5" ariaLabel="Track an order">
        <FormErrors errors={errors} />
        <TextField name="number" label="Order number" required value={values?.number} errors={errors} placeholder="GD-1001" />
        <TextField name="email" label="Email" type="email" required autoComplete="email" value={values?.email} errors={errors} />
        <div>
          <button type="submit" className="btn btn-primary">
            Find my order
          </button>
        </div>
      </Form>
    </div>
  );
}
