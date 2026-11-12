-- Person + profiles (delivery 1, 2026-11-12). ADDITIVE ONLY.
--
-- Generated offline, with no database connection, from the two schema files:
--   npx prisma migrate diff --from-schema <git show HEAD:prisma/schema.prisma> --to-schema prisma/schema.prisma --script
-- (Prisma 7 names the flags --from-schema / --to-schema; older versions call
-- them --from-schema-datamodel / --to-schema-datamodel.)
--
-- What it does: two new tables (persons, person_logs), six new NULLABLE
-- columns, four indexes and two foreign keys (both ON DELETE SET NULL).
-- No existing column, constraint, index or row is touched: the relation names
-- "MediaMember" / "MediaPublishedBy" exist only in the Prisma schema and
-- produce no SQL. tests/unit/additive-sql.test.ts fails if this file ever
-- stops being additive.
--
-- This is exactly what `prisma db push` applies for these schema changes.
-- Apply it on a copy first.
--
-- BEFORE THE CODE GOES LIVE, apply this file by hand first and check that
-- the columns exist: prisma/additive/README.md has the procedure (backup,
-- read-only preview, apply in one transaction, verify, then the code). The
-- new code selects these columns in every Media and Influencer query and
-- fails without them. Until 12 Nov 2026 the build command was `prisma
-- generate && prisma db push --accept-data-loss || echo 'db push skipped (no
-- DATABASE_URL)' && next build`: when the push could not reach the database
-- it was SKIPPED and the build went on, and whether the Railway build ever
-- reached the database has not been verified. The build no longer pushes
-- anything, so nothing applies this file but a person.
--
-- ONCE IT IS LIVE, NEVER BUILD OR PUSH A SCHEMA THAT LACKS THIS DELIVERY.
-- `prisma db push --accept-data-loss` makes the database EQUAL to the schema
-- it is run with. Run by hand from a checkout cut before this delivery (a
-- `railway run prisma db push` from an old checkout), or by the build of a
-- commit from before 12 Nov 2026 (its build script still pushes) with a
-- DATABASE_URL that reaches production, it drops persons, person_logs and
-- the six columns WITH THEIR DATA, without asking: every linked profile, the
-- whole audit log and every "published by" marker. The members and the totals
-- survive (media.influencerId is untouched), the identity of the creators
-- does not.
--   - Rebase or merge EVERY branch that can reach production onto this
--     prisma/schema.prisma before deploying it.
--   - To roll the application back, redeploy the previous IMAGE in Railway
--     (no build runs, nothing is pushed), or revert the code in a commit that
--     KEEPS prisma/schema.prisma as it is here. Never rebuild an older commit.

-- AlterTable
ALTER TABLE "influencers" ADD COLUMN     "addedById" TEXT,
ADD COLUMN     "addedByName" TEXT,
ADD COLUMN     "personId" TEXT;

-- AlterTable
ALTER TABLE "campaign_influencers" ADD COLUMN     "addedById" TEXT,
ADD COLUMN     "addedByName" TEXT;

-- AlterTable
ALTER TABLE "media" ADD COLUMN     "publishedByInfluencerId" TEXT;

-- CreateTable
CREATE TABLE "persons" (
    "id" TEXT NOT NULL,
    "displayName" TEXT,
    "createdById" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "person_logs" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "personId" TEXT,
    "actorId" TEXT,
    "actorName" TEXT,
    "evidence" TEXT,
    "summary" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,
    "undoOfId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "person_logs_personId_idx" ON "person_logs"("personId");

-- CreateIndex
CREATE INDEX "person_logs_createdAt_idx" ON "person_logs"("createdAt");

-- CreateIndex
CREATE INDEX "influencers_personId_idx" ON "influencers"("personId");

-- CreateIndex
CREATE INDEX "media_publishedByInfluencerId_idx" ON "media"("publishedByInfluencerId");

-- AddForeignKey
ALTER TABLE "influencers" ADD CONSTRAINT "influencers_personId_fkey" FOREIGN KEY ("personId") REFERENCES "persons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_publishedByInfluencerId_fkey" FOREIGN KEY ("publishedByInfluencerId") REFERENCES "influencers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

