-- INSECURE: rewrites the whole table under an ACCESS EXCLUSIVE lock.
ALTER TABLE "user" ADD COLUMN "status" varchar NOT NULL;

-- INSECURE: blocks writes for the duration of the build.
CREATE INDEX "idx_user_email" ON "user" ("email");
