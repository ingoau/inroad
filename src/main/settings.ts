import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AiProvider, MailSettings, McpServer, PublicSettings, SettingsPatch } from '../shared/api'

// Secrets are encrypted with the OS keychain (safeStorage) before touching disk.
interface StoredSettings {
  mail: MailSettings | null
  mailPassword?: string // base64 of encrypted bytes
  anthropicKey?: string
  aiProvider?: AiProvider
  desktopNotifications?: boolean
  opencodePath?: string
  opencodeModel?: string
  opencodeResearchModel?: string
  opencodeChatModel?: string
  opencodeFallbackModel?: string
  opencodeAgent?: string
  opencodeSubAgentModel?: string
  // The whole MCP server list, encrypted as one JSON blob (headers and env
  // often hold API keys, just like the mail password).
  mcpServers?: string
}

// Everything the main process needs to run a request against the chosen backend.
export interface AiConfig {
  provider: AiProvider
  anthropicKey?: string
  mcpServers: McpServer[]
  opencode: {
    executable: string
    workspace: string
    model?: string
    researchModel?: string
    chatModel?: string
    fallbackModel?: string
    agent: string
    subAgentModel?: string
  }
}

const file = () => join(app.getPath('userData'), 'settings.json')

// Each agent run gets its own empty working folder (see claude.ts / opencode.ts).
const agentWorkspace = () => join(app.getPath('userData'), 'agent-workspace')

async function read(): Promise<StoredSettings> {
  try {
    return JSON.parse(await readFile(file(), 'utf8'))
  } catch {
    return { mail: null }
  }
}

async function write(s: StoredSettings) {
  await mkdir(dirname(file()), { recursive: true })
  await writeFile(file(), JSON.stringify(s, null, 2), { mode: 0o600 })
}

// Secrets are encrypted with the OS keychain (safeStorage) when it's available.
// Some systems (headless Linux, servers without a keyring) have no keychain;
// rather than fail every save, fall back to a 0600 file and mark the value so
// it can still be read back. Older saves had no prefix and are treated as safe.
const PLAIN_PREFIX = 'plain:'
const SAFE_PREFIX = 'safe:'

function encrypt(plain: string): string {
  if (safeStorage.isEncryptionAvailable()) return SAFE_PREFIX + safeStorage.encryptString(plain).toString('base64')
  console.warn('Inroad: no OS keychain available, storing settings unencrypted')
  return PLAIN_PREFIX + Buffer.from(plain, 'utf8').toString('base64')
}

function decrypt(enc?: string): string | undefined {
  if (!enc) return undefined
  if (enc.startsWith(PLAIN_PREFIX)) return Buffer.from(enc.slice(PLAIN_PREFIX.length), 'base64').toString('utf8')
  const raw = enc.startsWith(SAFE_PREFIX) ? enc.slice(SAFE_PREFIX.length) : enc
  return safeStorage.decryptString(Buffer.from(raw, 'base64'))
}

// The whole MCP list is stored as one encrypted JSON blob; decrypt it back into
// the array the renderer and backends expect. A bad blob reads as no servers.
function decryptMcp(enc?: string): McpServer[] {
  const json = decrypt(enc)
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as McpServer[]) : []
  } catch {
    return []
  }
}

const toPublic = (s: StoredSettings): PublicSettings => ({
  mail: s.mail,
  hasMailPassword: !!s.mailPassword,
  hasAnthropicKey: !!s.anthropicKey,
  aiProvider: s.aiProvider ?? 'claude',
  opencode: {
    path: s.opencodePath ?? '',
    model: s.opencodeModel ?? '',
    researchModel: s.opencodeResearchModel ?? '',
    chatModel: s.opencodeChatModel ?? '',
    fallbackModel: s.opencodeFallbackModel ?? '',
    agent: s.opencodeAgent ?? '',
    subAgentModel: s.opencodeSubAgentModel ?? '',
  },
  mcpServers: decryptMcp(s.mcpServers),
  secureStorage: safeStorage.isEncryptionAvailable(),
  desktopNotifications: s.desktopNotifications ?? false,
})

export async function getPublicSettings() {
  return toPublic(await read())
}

export async function updateSettings(patch: SettingsPatch) {
  const s = await read()
  if (patch.mail) s.mail = patch.mail
  // Empty string clears a secret; undefined leaves it unchanged.
  if (patch.mailPassword !== undefined) s.mailPassword = patch.mailPassword ? encrypt(patch.mailPassword) : undefined
  if (patch.anthropicKey !== undefined) s.anthropicKey = patch.anthropicKey ? encrypt(patch.anthropicKey) : undefined
  if (patch.aiProvider !== undefined) s.aiProvider = patch.aiProvider
  if (patch.opencodePath !== undefined) s.opencodePath = patch.opencodePath
  if (patch.opencodeModel !== undefined) s.opencodeModel = patch.opencodeModel
  if (patch.opencodeResearchModel !== undefined) s.opencodeResearchModel = patch.opencodeResearchModel
  if (patch.opencodeChatModel !== undefined) s.opencodeChatModel = patch.opencodeChatModel
  if (patch.opencodeFallbackModel !== undefined) s.opencodeFallbackModel = patch.opencodeFallbackModel
  if (patch.opencodeAgent !== undefined) s.opencodeAgent = patch.opencodeAgent
  if (patch.opencodeSubAgentModel !== undefined) s.opencodeSubAgentModel = patch.opencodeSubAgentModel
  if (patch.mcpServers !== undefined) s.mcpServers = patch.mcpServers.length ? encrypt(JSON.stringify(patch.mcpServers)) : undefined
  if (patch.desktopNotifications !== undefined) s.desktopNotifications = patch.desktopNotifications
  await write(s)
  return toPublic(s)
}

// Main-process only: full settings including decrypted secrets.
export async function getSecrets() {
  const s = await read()
  return { mail: s.mail, mailPassword: decrypt(s.mailPassword), anthropicKey: decrypt(s.anthropicKey) }
}

// Main-process only: what the AI dispatcher (ai.ts) needs for one request.
export async function getAiConfig(): Promise<AiConfig> {
  const s = await read()
  return {
    provider: s.aiProvider ?? 'claude',
    anthropicKey: decrypt(s.anthropicKey),
    mcpServers: decryptMcp(s.mcpServers),
    opencode: {
      executable: s.opencodePath?.trim() || 'opencode',
      workspace: agentWorkspace(),
      model: s.opencodeModel?.trim() || undefined,
      researchModel: s.opencodeResearchModel?.trim() || undefined,
      chatModel: s.opencodeChatModel?.trim() || undefined,
    fallbackModel: s.opencodeFallbackModel?.trim() || undefined,
    agent: s.opencodeAgent?.trim() || 'inroad',
    subAgentModel: s.opencodeSubAgentModel?.trim() || undefined,
  },
  }
}
