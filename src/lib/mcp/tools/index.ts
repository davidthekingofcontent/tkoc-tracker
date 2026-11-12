/**
 * The tools of the MCP connector, in the order Claude lists them. All of them
 * read; none writes. A tool that writes will be a new entry here, behind its
 * own scope, added one by one.
 *
 *   list_campaigns          campaigns.ts
 *   get_campaign            campaigns.ts
 *   list_campaign_creators  campaigns.ts
 *   list_campaign_media     campaigns.ts
 *   find_creator            creators.ts
 *   get_creator             creators.ts
 *   capture_status          capture-status.ts
 *   explain_missing_post    explain-missing-post.ts
 */
import { getCampaign, listCampaignCreators, listCampaignMedia, listCampaigns } from './campaigns'
import { captureStatus } from './capture-status'
import { findCreator, getCreator } from './creators'
import { explainMissingPost } from './explain-missing-post'
import type { McpTool } from './shared'

export const MCP_TOOLS: readonly McpTool[] = [
  listCampaigns,
  getCampaign,
  listCampaignCreators,
  listCampaignMedia,
  findCreator,
  getCreator,
  captureStatus,
  explainMissingPost,
]

export type { McpTool, ToolCaller } from './shared'
