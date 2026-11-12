-- INVERSE of 2026-11-12-person-profiles.sql. NEVER RUN AUTOMATICALLY.
--
-- Generated offline with the same command, schemas swapped. It is destructive
-- by nature: it deletes the tables persons and person_logs and the columns
-- influencers.personId / addedById / addedByName,
-- campaign_influencers.addedById / addedByName and
-- media.publishedByInfluencerId, with whatever they hold.
--
-- YOU PROBABLY DO NOT NEED THIS FILE. Until 12 Nov 2026 the build command
-- ran `prisma db push --accept-data-loss`; it no longer does (see
-- prisma/additive/README.md). But that push, run with ANY
-- prisma/schema.prisma that lacks the models of this delivery, still does
-- what this script does, on its own and without asking: the build of a
-- commit from before 12 Nov 2026 (its build script still pushes) with a
-- DATABASE_URL that reaches production, a branch cut before the delivery, a
-- `railway run prisma db push` from an old checkout. That is the danger, not
-- a feature:
--   - To roll the APPLICATION back and KEEP the data, redeploy the previous
--     image in Railway (no build runs, nothing is pushed), or revert the code
--     in a commit that keeps prisma/schema.prisma as it is in this delivery.
--     The tables and the columns stay; the old code simply ignores them.
--   - Never rebuild or push a commit whose schema lacks these models while
--     the data matters. Rebase every branch that can reach production onto
--     this schema first.
--
-- Only when the tables and columns themselves must go, by hand:
--   1. Take a backup. Export persons, person_logs and the pairs
--      (id, publishedByInfluencerId) of media and (id, personId) of influencers.
--   2. Put the code of BEFORE this delivery live first WITHOUT A BUILD
--      (redeploy the previous image): the current code selects these columns
--      and every Media and Influencer query would fail without them. A build
--      of that older code would run `prisma db push --accept-data-loss` and
--      drop everything below by itself, before step 1 is of any use.
--   3. Run this script.
-- Content added through the new flow stays attached to its campaign member
-- (media.influencerId is never changed by this script), so no total moves.
-- What is lost for good: which profile published each piece (the client's
-- "vs su habitual" then compares cross-network pieces with the member's own
-- baseline and estimates use the member's followers), every linked profile
-- and the audit log.

BEGIN;

-- DropForeignKey
ALTER TABLE "influencers" DROP CONSTRAINT "influencers_personId_fkey";

-- DropForeignKey
ALTER TABLE "media" DROP CONSTRAINT "media_publishedByInfluencerId_fkey";

-- DropIndex
DROP INDEX "influencers_personId_idx";

-- DropIndex
DROP INDEX "media_publishedByInfluencerId_idx";

-- AlterTable
ALTER TABLE "influencers" DROP COLUMN "addedById",
DROP COLUMN "addedByName",
DROP COLUMN "personId";

-- AlterTable
ALTER TABLE "campaign_influencers" DROP COLUMN "addedById",
DROP COLUMN "addedByName";

-- AlterTable
ALTER TABLE "media" DROP COLUMN "publishedByInfluencerId";

-- DropTable
DROP TABLE "persons";

-- DropTable
DROP TABLE "person_logs";


COMMIT;
