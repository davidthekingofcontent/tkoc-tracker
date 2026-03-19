-- CreateEnum
CREATE TYPE "InfluencerStatus" AS ENUM ('PROSPECT', 'OUTREACH', 'NEGOTIATING', 'AGREED', 'CONTRACTED', 'POSTED', 'COMPLETED');

-- AlterTable
ALTER TABLE "campaign_influencers" ADD COLUMN     "status" "InfluencerStatus" NOT NULL DEFAULT 'PROSPECT';
