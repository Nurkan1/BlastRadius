/**
 * BlastRadius MCP server factory.
 *
 * Creates an @modelcontextprotocol/sdk McpServer instance, registers
 * all read-only tools and resources from this Phase 1, and returns
 * the configured server. The HTTP transport is mounted separately
 * (see transport-http.js) so the same server instance can also be
 * exposed via stdio in Phase 2 without duplication.
 *
 * Protocol version: the SDK negotiates the MCP wire version
 * automatically during the `initialize` handshake — clients send
 * the version they speak, the SDK picks the highest one this server
 * library supports, and the response surfaces the chosen value. We
 * never hard-code a wire version; instead we document the SDK
 * version we ship with in docs/mcp.md so users can match a
 * compatible client.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerTools } from './tools.js'
import { registerResources } from './resources.js'

export const MCP_SERVER_NAME = 'blastradius'

/**
 * Build a fresh McpServer wired against the live BlastRadius services.
 *
 * @param {object} deps
 * @param {Function} deps.getRepoContext    () => RepoContext | null
 * @param {object}   deps.eventStore        EventStore singleton
 * @param {object}   deps.iterationMarker   IterationMarker singleton
 * @param {object}   deps.preferences       PreferencesStore singleton
 * @param {Function} deps.repoDetector      () => RepoDetector | null
 * @param {number}   [deps.depth=2]         Propagation depth (matches /api/heat)
 * @param {object}   [deps.serverInfo]      Optional metadata echoed by blastradius://health
 * @param {string}   deps.appVersion        Package version string (passed to the SDK)
 */
export function createMcpServer({
  getRepoContext,
  eventStore,
  iterationMarker,
  preferences,
  repoDetector,
  depth = 2,
  serverInfo,
  appVersion,
  // rc8+: multi-repo singleton used by the set_node_summary write tool.
  knowledgeStore,
}) {
  const mcpServer = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: appVersion || '0.0.0',
    },
    {
      // We expose tools + resources only in Phase 1. No prompts,
      // no sampling, no notifications. Future phases will flip
      // additional capabilities on without breaking the contract.
      capabilities: {
        tools: {},
        resources: {},
      },
      // Brief instruction text the MCP client surfaces to the LLM
      // during the initialize handshake. Keep it short — clients
      // sometimes prepend this to every prompt.
      instructions:
        "BlastRadius observability. Use tools/resources to inspect the active iteration, " +
        "summarize recent file activity, list iteration windows, and read git diffs of " +
        "edited files in the active repo. All endpoints are read-only.",
    },
  )

  registerTools({
    mcpServer,
    getRepoContext,
    eventStore,
    iterationMarker,
    preferences,
    depth,
    knowledgeStore,
  })

  registerResources({
    mcpServer,
    getRepoContext,
    eventStore,
    iterationMarker,
    preferences,
    repoDetector,
    depth,
    serverInfo,
  })

  return mcpServer
}
