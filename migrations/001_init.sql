-- GlowDerma Store — initial schema
-- Money is stored as integer paise (₹1 = 100 paise). Tax rates in basis points (1800 = 18%).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────── Users, sessions, auth ─────────────
CREATE TYPE user_role AS ENUM ('customer', 'staff', 'pharmacist', 'admin');

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  name            text NOT NULL,
  phone           text,
  password_hash   text NOT NULL,
  role            user_role NOT NULL DEFAULT 'customer',
  marketing_opt_in boolean NOT NULL DEFAULT false,
  failed_logins   int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  disabled_at     timestamptz,
  deleted_at      timestamptz,
  pharmacist_reg_no text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TABLE sessions (
  id           text PRIMARY KEY,               -- sha256(token); raw token only lives in the cookie
  user_id      uuid REFERENCES users(id) ON DELETE CASCADE,
  csrf_secret  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE password_reset_tokens (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE addresses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label      text,
  full_name  text NOT NULL,
  phone      text NOT NULL,
  line1      text NOT NULL,
  line2      text,
  landmark   text,
  city       text NOT NULL,
  state      text NOT NULL,
  pincode    text NOT NULL CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user_idx ON addresses (user_id);

-- ───────────── Catalogue ─────────────
CREATE TYPE product_status AS ENUM ('draft', 'active', 'archived');
CREATE TYPE product_class AS ENUM ('cosmetic', 'personal_care', 'otc_pharmacy', 'prescription');

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text NOT NULL,
  description text,
  department  text NOT NULL DEFAULT 'skincare' CHECK (department IN ('skincare', 'cosmetology', 'body-hair', 'pharmacy')),
  sort_order  int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brands (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text NOT NULL,
  description text,
  is_sample   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                 text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name                 text NOT NULL,
  brand_id             uuid NOT NULL REFERENCES brands(id),
  category_id          uuid NOT NULL REFERENCES categories(id),
  short_description    text NOT NULL DEFAULT '',
  description          text NOT NULL DEFAULT '',
  key_active           text,             -- e.g. 'Salicylic acid'
  key_active_strength  text,             -- e.g. '2%'
  ingredients          text,             -- full INCI / composition list
  usage_instructions   text,
  warnings             text,
  storage              text,
  manufacturer_name    text,
  manufacturer_address text,
  marketed_by          text,
  country_of_origin    text,
  classification       product_class NOT NULL DEFAULT 'cosmetic',
  classification_verified boolean NOT NULL DEFAULT false,  -- set true only after regulatory review
  requires_prescription boolean NOT NULL DEFAULT false,
  hsn_code             text,
  tax_rate_bps         int NOT NULL DEFAULT 1800 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  status               product_status NOT NULL DEFAULT 'draft',
  is_featured          boolean NOT NULL DEFAULT false,
  images               jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{url, alt}]
  tags                 text[] NOT NULL DEFAULT '{}',
  skin_types           text[] NOT NULL DEFAULT '{}',
  seo_title            text,
  seo_description      text,
  is_sample            boolean NOT NULL DEFAULT false,
  published_at         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  search_vector        tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(key_active, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(short_description, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(ingredients, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(description, '')), 'D')
  ) STORED,
  CONSTRAINT rx_consistency CHECK (classification <> 'prescription' OR requires_prescription)
);
CREATE INDEX products_category_idx ON products (category_id) WHERE status = 'active';
CREATE INDEX products_brand_idx ON products (brand_id);
CREATE INDEX products_search_idx ON products USING gin (search_vector);
CREATE INDEX products_name_trgm_idx ON products (lower(name));

CREATE TABLE product_variants (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id          uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku                 text NOT NULL UNIQUE,
  name                text NOT NULL,                 -- pack size, e.g. '100 ml'
  mrp_paise           int NOT NULL CHECK (mrp_paise > 0),
  price_paise         int NOT NULL CHECK (price_paise > 0),
  stock               int NOT NULL DEFAULT 0 CHECK (stock >= 0),
  low_stock_threshold int NOT NULL DEFAULT 5 CHECK (low_stock_threshold >= 0),
  weight_grams        int NOT NULL DEFAULT 100 CHECK (weight_grams > 0),
  is_default          boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  sort_order          int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT price_not_above_mrp CHECK (price_paise <= mrp_paise)
);
CREATE INDEX variants_product_idx ON product_variants (product_id);

CREATE TABLE inventory_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  variant_id  uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  batch_no    text NOT NULL,
  mfg_date    date,
  expiry_date date NOT NULL,
  quantity    int NOT NULL CHECK (quantity >= 0),
  notes       text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (variant_id, batch_no)
);
CREATE INDEX batches_expiry_idx ON inventory_batches (expiry_date);

CREATE TYPE stock_reason AS ENUM ('initial', 'adjustment', 'restock', 'order_reserved', 'order_released', 'return', 'damage', 'expiry');

CREATE TABLE stock_movements (
  id            bigserial PRIMARY KEY,
  variant_id    uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  delta         int NOT NULL,
  balance_after int NOT NULL CHECK (balance_after >= 0),
  reason        stock_reason NOT NULL,
  reference     text,
  note          text,
  actor_id      uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_variant_idx ON stock_movements (variant_id, created_at DESC);

-- ───────────── Cart, wishlist, recently viewed ─────────────
CREATE TABLE carts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  session_id  text UNIQUE,
  coupon_code text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cart_owner CHECK (user_id IS NOT NULL OR session_id IS NOT NULL)
);

CREATE TABLE cart_items (
  cart_id    uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity   int NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cart_id, variant_id)
);

CREATE TABLE wishlist_items (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

CREATE TABLE recently_viewed (
  owner_key  text NOT NULL,          -- 'u:<user id>' or 's:<session id>'
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  viewed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_key, product_id)
);

-- ───────────── Coupons ─────────────
CREATE TABLE coupons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  kind             text NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value            int NOT NULL CHECK (value > 0),      -- percent (1–90) or paise
  min_subtotal_paise int NOT NULL DEFAULT 0,
  max_discount_paise int,
  starts_at        timestamptz,
  ends_at          timestamptz,
  usage_limit      int,
  per_user_limit   int NOT NULL DEFAULT 1,
  used_count       int NOT NULL DEFAULT 0,
  exclude_pharmacy boolean NOT NULL DEFAULT true,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT percent_range CHECK (kind <> 'percent' OR value BETWEEN 1 AND 90)
);
CREATE UNIQUE INDEX coupons_code_key ON coupons (upper(code));

-- ───────────── Prescriptions ─────────────
CREATE TYPE rx_status AS ENUM ('pending', 'approved', 'rejected', 'expired');

CREATE TABLE prescriptions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key    text NOT NULL UNIQUE,     -- file name inside PRESCRIPTION_STORAGE_DIR (never web-served directly)
  original_name  text NOT NULL,
  mime_type      text NOT NULL,
  size_bytes     int NOT NULL,
  sha256         text NOT NULL,
  patient_name   text NOT NULL,
  doctor_name    text,
  doctor_reg_no  text,
  issued_on      date,
  status         rx_status NOT NULL DEFAULT 'pending',
  reviewer_id    uuid REFERENCES users(id),
  reviewed_at    timestamptz,
  review_notes   text,
  valid_until    date,
  delete_after   date NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX prescriptions_status_idx ON prescriptions (status, created_at);

-- ───────────── Orders & payments ─────────────
CREATE TYPE order_status AS ENUM (
  'pending_payment', 'payment_failed', 'confirmed', 'processing', 'shipped', 'delivered',
  'cancellation_requested', 'cancelled', 'return_requested', 'returned', 'refunded', 'needs_attention'
);
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'failed', 'cod_pending', 'cod_collected', 'refund_pending', 'refunded', 'partially_refunded');

CREATE SEQUENCE order_number_seq START 1001;

CREATE TABLE orders (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             text NOT NULL UNIQUE,
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  email              text NOT NULL,
  phone              text NOT NULL,
  status             order_status NOT NULL DEFAULT 'pending_payment',
  payment_method     text NOT NULL CHECK (payment_method IN ('online', 'cod')),
  payment_status     payment_status NOT NULL DEFAULT 'pending',
  subtotal_paise     int NOT NULL CHECK (subtotal_paise >= 0),
  discount_paise     int NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  shipping_paise     int NOT NULL DEFAULT 0 CHECK (shipping_paise >= 0),
  cod_fee_paise      int NOT NULL DEFAULT 0 CHECK (cod_fee_paise >= 0),
  tax_paise          int NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),   -- GST included in prices; informational
  total_paise        int NOT NULL CHECK (total_paise >= 0),
  coupon_code        text,
  shipping_address   jsonb NOT NULL,
  customer_note      text,
  requires_rx_review boolean NOT NULL DEFAULT false,
  rx_review_status   text CHECK (rx_review_status IN ('pending', 'approved', 'rejected')),
  rx_reviewer_id     uuid REFERENCES users(id),
  prescription_id    uuid REFERENCES prescriptions(id),
  reservation_expires_at timestamptz,
  idempotency_key    text NOT NULL,
  paid_at            timestamptz,
  cancelled_at       timestamptz,
  cancel_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX orders_idempotency_key ON orders (idempotency_key);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders (status, created_at DESC);
CREATE INDEX orders_created_idx ON orders (created_at);

CREATE TABLE order_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id              uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id            uuid REFERENCES products(id) ON DELETE SET NULL,
  variant_id            uuid REFERENCES product_variants(id) ON DELETE SET NULL,
  product_name          text NOT NULL,
  variant_name          text NOT NULL,
  sku                   text NOT NULL,
  unit_price_paise      int NOT NULL,
  unit_mrp_paise        int NOT NULL,
  quantity              int NOT NULL CHECK (quantity > 0),
  tax_rate_bps          int NOT NULL,
  line_total_paise      int NOT NULL,
  line_discount_paise   int NOT NULL DEFAULT 0,
  tax_paise             int NOT NULL,
  requires_prescription boolean NOT NULL DEFAULT false,
  hsn_code              text
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE order_events (
  id         bigserial PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     text NOT NULL,
  note       text,
  visible_to_customer boolean NOT NULL DEFAULT true,
  actor_id   uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order_idx ON order_events (order_id, created_at);

CREATE TABLE coupon_redemptions (
  coupon_id  uuid NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (coupon_id, order_id)
);

CREATE TYPE attempt_status AS ENUM ('created', 'authorized', 'captured', 'failed', 'cancelled');

CREATE TABLE payment_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id            uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider            text NOT NULL,
  provider_order_id   text NOT NULL UNIQUE,
  provider_payment_id text UNIQUE,
  amount_paise        int NOT NULL CHECK (amount_paise > 0),
  currency            text NOT NULL DEFAULT 'INR',
  status              attempt_status NOT NULL DEFAULT 'created',
  signature_verified  boolean NOT NULL DEFAULT false,
  failure_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_attempts_order_idx ON payment_attempts (order_id);

-- Every webhook/callback event is recorded once; replays are ignored (idempotency).
CREATE TABLE payment_events (
  id           bigserial PRIMARY KEY,
  provider     text NOT NULL,
  event_id     text NOT NULL,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  outcome      text,
  UNIQUE (provider, event_id)
);

-- Ledger for the built-in sandbox gateway only (stands in for the provider's own records).
CREATE TABLE sandbox_payments (
  provider_order_id   text PRIMARY KEY,
  provider_payment_id text UNIQUE,
  amount_paise        int NOT NULL,
  status              text NOT NULL DEFAULT 'created',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Fulfilment, returns ─────────────
CREATE TABLE shipments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  carrier         text NOT NULL,
  tracking_number text NOT NULL,
  tracking_url    text,
  status          text NOT NULL DEFAULT 'in_transit' CHECK (status IN ('label_created', 'in_transit', 'out_for_delivery', 'delivered', 'returned')),
  shipped_at      timestamptz NOT NULL DEFAULT now(),
  delivered_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shipments_order_idx ON shipments (order_id);

CREATE TYPE return_status AS ENUM ('requested', 'approved', 'rejected', 'received', 'refunded');

CREATE TABLE return_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id           uuid REFERENCES users(id) ON DELETE SET NULL,
  kind              text NOT NULL DEFAULT 'return' CHECK (kind IN ('return', 'refund_only')),
  reason            text NOT NULL,
  details           text,
  status            return_status NOT NULL DEFAULT 'requested',
  refund_paise      int CHECK (refund_paise >= 0),
  refund_reference  text,
  admin_note        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX returns_order_idx ON return_requests (order_id);
CREATE UNIQUE INDEX returns_one_open_per_order ON return_requests (order_id) WHERE status IN ('requested', 'approved', 'received');

-- ───────────── Admin, settings, misc ─────────────
CREATE TABLE audit_logs (
  id         bigserial PRIMARY KEY,
  actor_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_role text,
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity, entity_id);

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE contact_messages (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  email      text NOT NULL,
  phone      text,
  topic      text NOT NULL,
  order_number text,
  message    text NOT NULL,
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Dev/test mail sink. Production uses a real provider (see DEPLOYMENT.md).
CREATE TABLE outbound_emails (
  id         bigserial PRIMARY KEY,
  to_email   text NOT NULL,
  subject    text NOT NULL,
  body       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
