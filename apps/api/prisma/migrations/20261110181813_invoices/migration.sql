/*
  Warnings:

  - A unique constraint covering the columns `[id,org_id]` on the table `clients` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('draft', 'sent', 'paid', 'overdue', 'void');

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "number" TEXT,
    "status" "invoice_status" NOT NULL DEFAULT 'draft',
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "subtotal_cents" BIGINT NOT NULL DEFAULT 0,
    "tax_cents" BIGINT NOT NULL DEFAULT 0,
    "total_cents" BIGINT NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "voided_at" TIMESTAMPTZ(6),
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "unit_price_cents" BIGINT NOT NULL,
    "tax_rate_bps" INTEGER NOT NULL,
    "line_total_cents" BIGINT NOT NULL,
    "line_tax_cents" BIGINT NOT NULL,

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_counters" (
    "org_id" UUID NOT NULL,
    "next_number" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "invoice_counters_pkey" PRIMARY KEY ("org_id")
);

-- CreateIndex
CREATE INDEX "invoices_org_id_status_idx" ON "invoices"("org_id", "status");

-- CreateIndex
CREATE INDEX "invoices_org_id_created_at_idx" ON "invoices"("org_id", "created_at");

-- CreateIndex
CREATE INDEX "invoices_client_id_idx" ON "invoices"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_org_id_number_key" ON "invoices"("org_id", "number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_id_org_id_key" ON "invoices"("id", "org_id");

-- CreateIndex
CREATE INDEX "invoice_line_items_org_id_idx" ON "invoice_line_items"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_line_items_invoice_id_position_key" ON "invoice_line_items"("invoice_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "clients_id_org_id_key" ON "clients"("id", "org_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_client_id_org_id_fkey" FOREIGN KEY ("client_id", "org_id") REFERENCES "clients"("id", "org_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_org_id_fkey" FOREIGN KEY ("invoice_id", "org_id") REFERENCES "invoices"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_counters" ADD CONSTRAINT "invoice_counters_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written: integrity constraints, row-level security, privileges.
-- Defence in depth: the application validates first, the database refuses
-- anything impossible even if the application has a bug.
-- ---------------------------------------------------------------------------

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_currency_check"
    CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "invoices_amounts_check"
    CHECK (subtotal_cents >= 0 AND tax_cents >= 0
           AND total_cents = subtotal_cents + tax_cents
           AND total_cents <= 9007199254740991),
  ADD CONSTRAINT "invoices_dates_check"
    CHECK (due_date >= issue_date),
  ADD CONSTRAINT "invoices_number_format_check"
    CHECK (number IS NULL OR number ~ '^INV-[0-9]{6,}$'),
  ADD CONSTRAINT "invoices_number_required_check"
    CHECK (number IS NOT NULL OR status IN ('draft', 'void'));

ALTER TABLE "invoice_line_items"
  ADD CONSTRAINT "line_items_position_check" CHECK (position >= 1),
  ADD CONSTRAINT "line_items_description_check"
    CHECK (char_length(description) BETWEEN 1 AND 500),
  ADD CONSTRAINT "line_items_quantity_check" CHECK (quantity > 0),
  ADD CONSTRAINT "line_items_amounts_check"
    CHECK (unit_price_cents >= 0 AND line_total_cents >= 0 AND line_tax_cents >= 0),
  ADD CONSTRAINT "line_items_tax_rate_check"
    CHECK (tax_rate_bps BETWEEN 0 AND 10000);

ALTER TABLE "invoice_counters"
  ADD CONSTRAINT "invoice_counters_next_check" CHECK (next_number >= 1);

-- Row-level security, forced so even the table owner is subject to it.
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoices" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoices"
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

ALTER TABLE "invoice_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_line_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoice_line_items"
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

ALTER TABLE "invoice_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "invoice_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "invoice_counters"
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

-- Invoices are soft-deleted only; a counter is never deleted by the app.
-- (Line items keep DELETE: editing a draft replaces its lines.)
REVOKE DELETE ON "invoices" FROM app_user;
REVOKE DELETE ON "invoice_counters" FROM app_user;
