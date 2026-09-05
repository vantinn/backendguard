-- SECURE control: nullable add, concurrent index, scoped update.
ALTER TABLE "order" ADD COLUMN "cancelled_at" timestamptz;
CREATE INDEX CONCURRENTLY "idx_order_user_id" ON "order" ("user_id");
UPDATE "order" SET "cancelled_at" = now() WHERE "status" = 'cancelled';
