/**
 * The write tools of the MCP connector (12 Nov 2026), in the order Claude
 * lists them, after the eight read tools of ../index.ts. Every one is built
 * with defineWriteTool (../../write-tool.ts) and acts as the administrator who
 * authorised the grant, through the platform's own routes.
 *
 *   campaigns.ts         create_campaign, update_campaign, set_campaign_status,
 *                        set_campaign_tracking_targets, set_campaign_goals,
 *                        record_business_results, delete_campaign,
 *                        revalidate_campaign_media, set_campaign_access
 *   creators.ts          add_creators_to_campaign, set_creator_status,
 *                        update_creator_deal, set_creator_shipping,
 *                        remove_creator_from_campaign,
 *                        move_creators_between_campaigns, add_creator_note,
 *                        analyze_creator_profile, import_creators_to_database,
 *                        run_paid_creator_search, update_creator_profile,
 *                        create_creator_manually, save_contact_address,
 *                        invite_creator_to_connect
 *   publications.ts      add_publications_by_url, register_stories,
 *                        correct_publication_metrics, tag_publications
 *   report.ts            set_report_visibility, edit_report_content,
 *                        mark_report_sent
 *   lists.ts             create_list, add_creators_to_list, update_list,
 *                        remove_creators_from_list, delete_list
 *   brands.ts            create_brand, update_brand, delete_brand
 *   tracking.ts          launch_campaign_tracking, sync_instagram_connection
 *   platform-request.ts  platform_request (the guarded generic tool, last)
 *
 * link_creator_profile (in the proposal) is not here: it needs a model that
 * only exists on another branch.
 */
import { registerWriteTool, type WriteTool, type WriteToolWiring } from '../../write-tool'
import { BRAND_WRITE_TOOLS, registerBrandWriteTools } from './brands'
import { CAMPAIGN_WRITE_TOOLS, registerCampaignWriteTools } from './campaigns'
import { CREATOR_WRITE_TOOLS, registerCreatorWriteTools } from './creators'
import { LIST_WRITE_TOOLS, registerListWriteTools } from './lists'
import { platformRequestTool, registerPlatformRequest } from './platform-request'
import { PUBLICATION_WRITE_TOOLS, registerPublicationWriteTools } from './publications'
import { REPORT_WRITE_TOOLS, registerReportWriteTools } from './report'
import { TRACKING_WRITE_TOOLS, registerTrackingWriteTools } from './tracking'

/** Every write tool, in the order registerWriteTools registers them. */
export const WRITE_TOOLS: readonly WriteTool[] = [
  ...CAMPAIGN_WRITE_TOOLS,
  ...CREATOR_WRITE_TOOLS,
  ...PUBLICATION_WRITE_TOOLS,
  ...REPORT_WRITE_TOOLS,
  ...LIST_WRITE_TOOLS,
  ...BRAND_WRITE_TOOLS,
  ...TRACKING_WRITE_TOOLS,
  platformRequestTool,
]

/**
 * Registers every write tool on the server of one request (src/lib/mcp/server.ts).
 * Each call spends one of the grant's tool calls (`take`), runs in turn with
 * the other calls of the request (`inTurn`) and writes its own log line.
 * A name registered twice throws: the server is never built half-wired.
 */
export function registerWriteTools(
  server: Parameters<typeof registerWriteTool>[0],
  wiring: WriteToolWiring,
  alreadyRegistered: Iterable<string> = [],
): void {
  const names = new Set<string>(alreadyRegistered)
  const claim = (name: string) => {
    if (names.has(name)) throw new Error(`MCP tool ${name} is registered twice`)
    names.add(name)
  }
  const register = (tool: WriteTool) => {
    claim(tool.name)
    registerWriteTool(server, wiring, tool)
  }
  registerCampaignWriteTools(register)
  registerCreatorWriteTools(register)
  registerPublicationWriteTools(register)
  registerReportWriteTools(register)
  registerListWriteTools(register)
  registerBrandWriteTools(register)
  registerTrackingWriteTools(register)
  claim(platformRequestTool.name)
  registerPlatformRequest(server, wiring)
}
