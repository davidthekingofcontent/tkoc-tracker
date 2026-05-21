import { NextRequest, NextResponse } from 'next/server'

/**
 * DEPRECATED — This endpoint was unsafe and could delete manually-added
 * CampaignInfluencer rows. It has been disabled. Use the per-row "Quitar"
 * button on the campaign Elegir tab to remove influencers one at a time.
 *
 * A future version will support multi-select deletion with checkboxes,
 * backed by a new `source` field on CampaignInfluencer (manual vs auto).
 */
export async function POST(_req: NextRequest) {
  return NextResponse.json(
    {
      error: 'Endpoint disabled',
      reason: 'This endpoint could delete profiles you added manually. Remove influencers one by one using the trash icon in the campaign Elegir tab.',
    },
    { status: 410 } // Gone
  )
}
