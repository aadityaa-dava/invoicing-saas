/*
  Warnings:

  - A unique constraint covering the columns `[recurring_template_id,recurring_run_on]` on the table `invoices` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "recurring_frequency" AS ENUM ('weekly', 'monthly', 'quarterly', 'yearly');

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "recurring_run_on" DATE,
ADD COLUMN     "recurring_template_id" UUID;

-- CreateTable
CREATE TABLE "recurring_templates" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "frequency" "recurring_frequency" NOT NULL,
    "anchor_date" DATE NOT NULL,
    "run_count" INTEGER NOT NULL DEFAULT 0,
    "next_run_on" DATE,
    "end_date" DATE,
    "due_in_days" INTEGER NOT NULL DEFAULT 30,
    "auto_send" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "recurring_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_template_line_items" (
    "id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,4) NOT NULL,
    "unit_price_cents" BIGINT NOT NULL,
    "tax_rate_bps" INTEGER NOT NULL,

    CONSTRAINT "recurring_template_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_templates_org_id_idx" ON "recurring_templates"("org_id");

-- CreateIndex
CREATE INDEX "recurring_templates_due_idx" ON "recurring_templates"("next_run_on");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_templates_id_org_id_key" ON "recurring_templates"("id", "org_id");

-- CreateIndex
CREATE INDEX "recurring_template_line_items_org_id_idx" ON "recurring_template_line_items"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_template_line_items_template_id_position_key" ON "recurring_template_line_items"("template_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_recurring_template_id_recurring_run_on_key" ON "invoices"("recurring_template_id", "recurring_run_on");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recurring_template_id_fkey" FOREIGN KEY ("recurring_template_id") REFERENCES "recurring_templates"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_templates" ADD CONSTRAINT "recurring_templates_client_id_org_id_fkey" FOREIGN KEY ("client_id", "org_id") REFERENCES "clients"("id", "org_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_template_line_items" ADD CONSTRAINT "recurring_template_line_items_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_template_line_items" ADD CONSTRAINT "recurring_template_line_items_template_id_org_id_fkey" FOREIGN KEY ("template_id", "org_id") REFERENCES "recurring_templates"("id", "org_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written: integrity constraints, row-level security, privileges.
-- ---------------------------------------------------------------------------

ALTER TABLE "recurring_templates"
  ADD CONSTRAINT "recurring_templates_currency_check"
    CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "recurring_templates_name_check"
    CHECK (char_length(name) BETWEEN 1 AND 200),
  ADD CONSTRAINT "recurring_templates_due_in_days_check"
    CHECK (due_in_days BETWEEN 0 AND 365),
  ADD CONSTRAINT "recurring_templates_run_count_check"
    CHECK (run_count >= 0),
  ADD CONSTRAINT "recurring_templates_end_date_check"
    CHECK (end_date IS NULL OR end_date >= anchor_date),
  ADD CONSTRAINT "recurring_templates_next_run_check"
    CHECK (next_run_on IS NULL OR next_run_on >= anchor_date);

ALTER TABLE "recurring_template_line_items"
  ADD CONSTRAINT "template_lines_position_check" CHECK (position >= 1),
  ADD CONSTRAINT "template_lines_description_check"
    CHECK (char_length(description) BETWEEN 1 AND 500),
  ADD CONSTRAINT "template_lines_quantity_check" CHECK (quantity > 0),
  ADD CONSTRAINT "template_lines_price_check" CHECK (unit_price_cents >= 0),
  ADD CONSTRAINT "template_lines_tax_rate_check"
    CHECK (tax_rate_bps BETWEEN 0 AND 10000);

-- An invoice is either generated from a template for a run date, or it is not.
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_recurring_pair_check"
    CHECK ((recurring_template_id IS NULL) = (recurring_run_on IS NULL));

-- Prisma cannot express a partial index. The schema declares this name so the
-- two stay in sync; here it is replaced by the version that stays small:
-- only live, active templates that still have a next run.
DROP INDEX "recurring_templates_due_idx";
CREATE INDEX "recurring_templates_due_idx" ON "recurring_templates" ("next_run_on")
  WHERE active AND deleted_at IS NULL AND next_run_on IS NOT NULL;

ALTER TABLE "recurring_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recurring_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recurring_templates"
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

ALTER TABLE "recurring_template_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recurring_template_line_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recurring_template_line_items"
  USING (org_id = app_current_org_id())
  WITH CHECK (org_id = app_current_org_id());

-- Templates are soft-deleted only. Line items keep DELETE: editing a template
-- replaces its lines.
REVOKE DELETE ON "recurring_templates" FROM app_user;
