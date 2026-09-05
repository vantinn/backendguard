ALTER TABLE "account" ADD COLUMN "locale" varchar DEFAULT 'en';
CREATE INDEX CONCURRENTLY "idx_account_email" ON "account" ("email");
UPDATE "account" SET "locale" = 'en' WHERE "locale" IS NULL;
SELECT id, email FROM "account" WHERE "locale" = 'en' LIMIT 100;
