import { app, safeStorage } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AiProvider, MailSettings, PublicSettings, SettingsPatch } from '../shared/api'

// Secrets are encrypted with the OS keychain (safeStorage) before touching disk.
interface StoredSettings {
  mail: MailSettings | null
  mailPassword?: string // base64 of encrypted bytes
  anthropicKey?: string
  aiProvider?: AiProvider
  claudeModel?: string
  claudeUtilityModel?: string
  opencodePath?: string
  opencodeModel?: string
  opencodeUtilityModel?: string
  opencodeAgent?: string
}

// Everything the main process needs to run a request against the chosen backend.
export interface AiConfig {
  provider: AiProvider
  claude: { apiKey?: string; model: string; utilityModel: string }
  opencode: { executable: string; workspace: string; model?: string; utilityModel?: string; agent: string }
}

// 'opus' resolves to the newest Opus the account can use; quick processing
// jobs default to the smaller, faster Haiku.
export const DEFAULT_CLAUDE_MODEL = 'opus'
export const DEFAULT_CLAUDE_UTILITY_MODEL = 'haiku'

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

const toPublic = (s: StoredSettings): PublicSettings => ({
  mail: s.mail,
  hasMailPassword: !!s.mailPassword,
  hasAnthropicKey: !!s.anthropicKey,
  aiProvider: s.aiProvider ?? 'claude',
  claude: { model: s.claudeModel ?? '', utilityModel: s.claudeUtilityModel ?? '' },
  opencode: { path: s.opencodePath ?? '', model: s.opencodeModel ?? '', utilityModel: s.opencodeUtilityModel ?? '', agent: s.opencodeAgent ?? '' },
  secureStorage: safeStorage.isEncryptionAvailable(),
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
  if (patch.claudeModel !== undefined) s.claudeModel = patch.claudeModel
  if (patch.claudeUtilityModel !== undefined) s.claudeUtilityModel = patch.claudeUtilityModel
  if (patch.opencodePath !== undefined) s.opencodePath = patch.opencodePath
  if (patch.opencodeModel !== undefined) s.opencodeModel = patch.opencodeModel
  if (patch.opencodeUtilityModel !== undefined) s.opencodeUtilityModel = patch.opencodeUtilityModel
  if (patch.opencodeAgent !== undefined) s.opencodeAgent = patch.opencodeAgent
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
    claude: {
      apiKey: decrypt(s.anthropicKey),
      model: s.claudeModel?.trim() || DEFAULT_CLAUDE_MODEL,
      utilityModel: s.claudeUtilityModel?.trim() || DEFAULT_CLAUDE_UTILITY_MODEL,
    },
    opencode: {
      executable: s.opencodePath?.trim() || 'opencode',
      workspace: agentWorkspace(),
      model: s.opencodeModel?.trim() || undefined,
      utilityModel: s.opencodeUtilityModel?.trim() || undefined,
      agent: s.opencodeAgent?.trim() || 'inroad',
    },
  }
}
