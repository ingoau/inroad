import type { McpAuthStatus, McpServer, Result } from '../shared/api'
import * as claude from './claude'
import * as opencode from './opencode'
import { getAiConfig } from './settings'

// Dispatches MCP OAuth work to the active backend. Both backends reuse their
// CLI's credential store, so signing in here signs in the terminal too (and
// signing out here signs it out).

const findServer = (servers: McpServer[], id: string) => servers.find((s) => s.id === id)

// Sign-in state for the configured remote servers, for the current provider.
export async function authStatus(): Promise<McpAuthStatus[]> {
  const cfg = await getAiConfig()
  claude.setMcpServers(cfg.mcpServers)
  opencode.setMcpServers(cfg.mcpServers)
  return cfg.provider === 'opencode' ? opencode.mcpAuthStatus(cfg.opencode) : claude.mcpAuthStatus()
}

// Starts an OAuth sign-in (opens the browser) and resolves once it finishes.
export async function authenticate(serverId: string): Promise<Result<McpAuthStatus>> {
  const cfg = await getAiConfig()
  claude.setMcpServers(cfg.mcpServers)
  opencode.setMcpServers(cfg.mcpServers)
  const server = findServer(cfg.mcpServers, serverId)
  if (!server) return { ok: false, error: 'That MCP server is no longer configured.' }
  return cfg.provider === 'opencode' ? opencode.authenticateMcp(cfg.opencode, server) : claude.authenticateMcp(cfg.anthropicKey, server)
}

// Removes one server's stored OAuth token.
export async function logout(serverId: string): Promise<Result<McpAuthStatus>> {
  const cfg = await getAiConfig()
  claude.setMcpServers(cfg.mcpServers)
  opencode.setMcpServers(cfg.mcpServers)
  const server = findServer(cfg.mcpServers, serverId)
  if (!server) return { ok: false, error: 'That MCP server is no longer configured.' }
  return cfg.provider === 'opencode' ? opencode.logoutMcp(cfg.opencode, server) : claude.logoutMcp(server)
}
