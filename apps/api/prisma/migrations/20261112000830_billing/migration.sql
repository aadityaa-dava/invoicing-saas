-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "stripe_checkout_session_id" TEXT;

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "stripe_payment_intent_id" TEXT NOT NULL,
    "stripe_checkout_session_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL,
    "stripe_subscription_id" TEXT NOT NULL,
    "current_period_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_events" (
    "stripe_event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "org_id" UUID,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("stripe_event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_stripe_payment_intent_id_key" ON "payments"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "payments_org_id_invoice_id_idx" ON "payments"("org_id", "invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_org_id_key" ON "subscriptions"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_stripe_subscription_id_key" ON "subscriptions"("stripe_subscription_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_org_id_fkey" FOREIGN KEY ("invoice_id", "org_id") REFERENCES "invoices"("id", "org_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Constraints the database enforces regardless of the application
-- ---------------------------------------------------------------------------

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_paid_check"
    CHECK (status <> 'paid' OR paid_at IS NOT NULL);

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_check"
    CHECK (amount_cents > 0 AND amount_cents <= 9007199254740991),
  ADD CONSTRAINT "payments_currency_check"
    CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "payments_status_check"
    CHECK (status IN ('succeeded', 'duplicate'));

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_plan_check"
    CHECK (plan IN ('free', 'pro')),
  ADD CONSTRAINT "subscriptions_status_check"
    CHECK (status IN ('incomplete', 'incomplete_expired', 'trialing', 'active',
                      'past_due', 'canceled', 'unpaid', 'paused'));

ALTER TABLE "webhook_events"
  ADD CONSTRAINT "webhook_events_outcome_check"
    CHECK (outcome IN ('processed', 'ignored', 'unmatched'));

-- ---------------------------------------------------------------------------
-- Row-level security, forced so even the table owner is subject to it
-- ---------------------------------------------------------------------------

ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "payments"
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "subscriptions"
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

-- Payments and subscriptions are never hard-deleted by the application.
REVOKE DELETE ON "payments" FROM app_user;
REVOKE DELETE ON "subscriptions" FROM app_user;

-- webhook_events is global (no tenant exists when an event arrives) and holds
-- ids, type and outcome only. It is append-only for the runtime role.
REVOKE UPDATE, DELETE ON "webhook_events" FROM app_user;
