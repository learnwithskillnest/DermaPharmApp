# Launch compliance review (India)

**This is not legal advice.** It is the engineering team's list of legal and regulatory questions that a **qualified Indian pharmacy/regulatory lawyer, a chartered accountant and a data-protection adviser must answer before launch**. The software provides switches and record-keeping for these; it cannot make the business compliant. Status notes were checked in October 2026 and may be out of date.

## A. Pharmacy and medicines — highest risk

| # | Question for counsel | What the app does today |
| --- | --- | --- |
| A1 | **Can this business sell medicines online at all, and under what licence?** India has no finalised e-pharmacy rules: draft rules amending the Drugs and Cosmetics Rules were published in 2018 but not finalised, and the Centre told the Delhi High Court in 2023 that it needed more time. Online sale of medicines has been the subject of litigation and regulator notices. | Prescription ordering is **OFF**. It needs `ENABLE_PRESCRIPTION_ORDERING=true` (server) **and** admin switch **and** recorded drug licence numbers **and** a registered pharmacist. Rx products can be hidden entirely (Admin → Settings). |
| A2 | Which licences are needed (retail/wholesale drug licences under the Drugs and Cosmetics Act 1940 / Rules 1945, for each premises that stores or dispatches medicines; state FDA requirements)? | Licence numbers are displayed on `/seller-information` once entered. |
| A3 | Which products are **Schedule H, H1 or X**, or otherwise restricted? Schedule X and narcotic/psychotropic drugs should not be listed at all. H1 requires a separate register. | Classification is per product (`cosmetic`, `personal_care`, `otc_pharmacy`, `prescription`) with a **"classification verified"** flag that is false for every sample product. There is no Schedule field yet — add one if counsel requires per-schedule rules. |
| A4 | What makes a prescription valid for online supply (registered medical practitioner, Telemedicine Practice Guidelines 2020, validity, re-use limits, original-vs-copy)? | Upload (PDF/JPG/PNG, content-sniffed), pharmacist approve/reject with notes, doctor registration number, validity date. Every Rx order is held for pharmacist approval and cannot be packed or dispatched until approved. |
| A5 | Record-keeping: what must be kept (sale records, prescription copies, batch numbers) and for how long? | Prescription retention is configurable (default 1,095 days, then auto-deleted). Order items keep SKU, HSN, tax rate. Batches/expiry tracked per variant, **but sold units are not yet linked to a specific batch** — add batch allocation at dispatch if required for traceability/recalls. |
| A6 | Delivery rules for medicines (cold chain, delivery to the patient, areas served). | PIN-code prefix blocking; COD disabled for Rx orders. No cold-chain handling — do not list temperature-sensitive products until solved. |
| A7 | Are discounts/coupons on medicines permitted? Advertising of medicines (Drugs and Magic Remedies (Objectionable Advertisements) Act 1954; Rx drugs must not be promoted). | Coupons exclude pharmacy by default; Rx products cannot be featured; no promotional copy on Rx pages. |
| A8 | Is **azelaic acid 10%** (and retinal, urea etc.) a cosmetic or a drug at the strength and claims used? | Sample listings carry a note that classification is unverified; copy avoids treatment claims. |

## B. Cosmetics and labelling

- **Cosmetics Rules 2020**: manufacturing/import registration of each product; label particulars shown online (manufacturer, address, batch, expiry/"use before", net quantity, ingredients). The product page has fields for all of these — **replace every `[Sample data]` placeholder with label data**.
- **Legal Metrology (Packaged Commodities) Rules 2011** (e-commerce declarations): MRP inclusive of taxes, net quantity, manufacturer/packer/importer, country of origin, consumer-care details. MRP is shown on every product and price can never exceed MRP (enforced in DB and forms).
- No unverified efficacy, "dermatologist-tested", "clinically proven", certification or approval claims. None are in the sample data — keep it that way unless substantiated.

## C. E-commerce and consumer protection

- **Consumer Protection (E-Commerce) Rules 2020**: seller legal name, address, GSTIN, customer-care contacts, **grievance officer** (name, contact; acknowledge within 48 hours, resolve within one month), return/refund/exchange/warranty/delivery policies, no fake reviews, no manipulated prices. Fields exist in Admin → Settings and are displayed on `/seller-information`, `/policies/*` and the footer. **Fill them in.** The app contains no reviews or ratings and no scarcity counters.
- **Policy pages are drafts** (each shows a "draft" banner): shipping, returns/refunds, privacy, terms, product safety. Have them reviewed and finalised.
- Cancellation/refund timelines promised in policies must match operations; refunds for prepaid cancellations are queued in Admin → Returns.

## D. Data protection and security

- **Digital Personal Data Protection Act 2023** and **DPDP Rules 2025** (notified 13 Nov 2025; most obligations — notice, consent, data-principal rights, breach notification, retention/erasure — commence **12 May 2027**). Prepare: consent notice at sign-up and prescription upload, purpose limitation, retention schedule, breach-notification process, a contact for data requests, processor contracts (hosting, email, payments).
- Health data (prescriptions) is highly sensitive — also treated as *sensitive personal data* under the IT (SPDI) Rules 2011 while they apply. The app restricts prescription documents to pharmacists, audits every view, uses random file names outside the web root, and auto-deletes after retention. **Use an encrypted volume** and restrict server access.
- **Payments**: card data never touches the app (Razorpay hosted checkout); RBI rules on card storage/tokenisation are handled by the gateway.
- **CERT-In directions (2022)**: incident reporting within 6 hours, log retention (180 days) — configure log shipping accordingly.

## E. Tax (chartered accountant)

- GST registration; correct **HSN codes and GST rates** per product. The seed values (cosmetics 18%; some personal care and medicines 5%; first-aid 12%) are **placeholders** — rates changed with the 2025 GST rationalisation and must be confirmed.
- Tax invoices: the app stores per-line taxable value and GST but does **not yet generate GST invoices** (invoice numbering series, CGST/SGST vs IGST split by place of supply). Add before launch or use an invoicing service.
- E-commerce TCS/TDS obligations depend on the business model (marketplace vs own inventory).

## F. Sign-off record

| Area | Reviewer | Date | Decision |
| --- | --- | --- | --- |
| Pharmacy licensing (A1–A7) | | | |
| Product classifications (A8, B) | | | |
| Consumer protection & policies (C) | | | |
| Data protection (D) | | | |
| Tax (E) | | | |
