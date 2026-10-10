import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DiscoveredMcpServer, McpKeyValue, McpServer } from '../shared/api'

// Finds MCP servers the user already configured for their agent, so they can add
// them to Inroad with one click instead of retyping command lines and URLs.
// Claude Code keeps them in ~/.claude.json (user scope, then per-project);
// opencode keeps them in its global config under "mcp".

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// "KEY: value" objects (env vars, headers) as the ordered rows the UI edits.
const pairs = (v: unknown): McpKeyValue[] =>
  isObject(v)
    ? Object.entries(v).map(([key, value]) => ({ key, value: typeof value === 'string' ? value : String(value ?? '') }))
    : []

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

// JSONC (opencode's config allows comments and trailing commas) parsed by
// stripping comments outside strings, then dropping trailing commas.
function readJsonc(file: string): unknown {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else {
      out += ch
    }
  }
  try {
    return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'))
  } catch {
    return undefined
  }
}

const base = (name: string): Omit<McpServer, 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers'> => ({
  id: randomUUID(),
  name,
  enabled: true,
})

// Claude Code's shape: { type: 'stdio'|'http'|'sse', command?, args?, env?, url?, headers? }.
function fromClaude(name: string, raw: unknown): McpServer | undefined {
  if (!isObject(raw)) return undefined
  const type = str(raw.type)
  if (type === 'http' || type === 'sse') {
    const url = str(raw.url)
    return url ? { ...base(name), transport: type, command: '', args: [], env: [], url, headers: pairs(raw.headers) } : undefined
  }
  const command = str(raw.command)
  if (!command) return undefined
  const args = Array.isArray(raw.args) ? raw.args.map(str).filter(Boolean) : []
  return { ...base(name), transport: 'stdio', command, args, env: pairs(raw.env), url: '', headers: [] }
}

// opencode's shape: { type: 'local', command: string[], environment? } or
// { type: 'remote', url, headers? }.
function fromOpencode(name: string, raw: unknown): McpServer | undefined {
  if (!isObject(raw)) return undefined
  if (str(raw.type) === 'remote') {
    const url = str(raw.url)
    return url ? { ...base(name), transport: 'http', command: '', args: [], env: [], url, headers: pairs(raw.headers) } : undefined
  }
  const [command, ...args] = Array.isArray(raw.command) ? raw.command.map(str).filter(Boolean) : [str(raw.command)]
  if (!command) return undefined
  return { ...base(name), transport: 'stdio', command, args, env: pairs(raw.environment), url: '', headers: [] }
}

const claudeConfigFile = () => join(process.env.CLAUDE_CONFIG_DIR || homedir(), '.claude.json')

// Claude Code's OAuth tokens and its "server needs auth" cache live in the
// Claude config dir. Inroad reads them so it can reuse a sign-in the CLI made.
export const claudeCredentialsFile = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), '.credentials.json')
export const claudeNeedsAuthFile = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'mcp-needs-auth-cache.json')

// opencode stores MCP OAuth tokens in its data dir, keyed by server name.
export const opencodeAuthFile = () => join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode', 'mcp-auth.json')

// Names (lowercased) of servers Claude Code has a usable OAuth token for.
export function claudeAuthenticatedServers(): Set<string> {
  const creds = readJson(claudeCredentialsFile())
  const oauth = isObject(creds) ? creds.mcpOAuth : undefined
  const names = new Set<string>()
  if (!isObject(oauth)) return names
  for (const entry of Object.values(oauth)) {
    if (isObject(entry) && str(entry.accessToken) && str(entry.serverName)) names.add(str(entry.serverName).toLowerCase())
  }
  return names
}

// Names (lowercased) Claude Code has flagged as needing sign-in.
export function claudeNeedsAuthServers(): Set<string> {
  const cache = readJson(claudeNeedsAuthFile())
  return new Set(isObject(cache) ? Object.keys(cache).map((k) => k.toLowerCase()) : [])
}

// Names (lowercased) opencode has a usable OAuth token for.
export function opencodeAuthenticatedServers(): Set<string> {
  const store = readJson(opencodeAuthFile())
  const names = new Set<string>()
  if (!isObject(store)) return names
  for (const [name, entry] of Object.entries(store)) {
    const tokens = isObject(entry) ? entry.tokens : undefined
    if (isObject(tokens) && str(tokens.accessToken)) names.add(name.toLowerCase())
  }
  return names
}

function discoverClaude(add: (s: McpServer | undefined, scope: string) => void) {
  const config = readJson(claudeConfigFile())
  if (!isObject(config)) return
  if (isObject(config.mcpServers)) for (const [name, raw] of Object.entries(config.mcpServers)) add(fromClaude(name, raw), 'user settings')
  // Servers added while working in a project live under that project's path.
  if (isObject(config.projects)) {
    for (const [path, project] of Object.entries(config.projects)) {
      if (!isObject(project) || !isObject(project.mcpServers)) continue
      for (const [name, raw] of Object.entries(project.mcpServers)) add(fromClaude(name, raw), path)
    }
  }
}

function opencodeConfigFiles(): string[] {
  if (process.env.OPENCODE_CONFIG) return [process.env.OPENCODE_CONFIG]
  const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  return [join(dir, 'opencode.json'), join(dir, 'opencode.jsonc')]
}

function discoverOpencode(add: (s: McpServer | undefined, scope: string) => void) {
  for (const file of opencodeConfigFiles()) {
    const config = readJsonc(file)
    if (!isObject(config) || !isObject(config.mcp)) continue
    for (const [name, raw] of Object.entries(config.mcp)) {
      // A server switched off in opencode isn't currently connected.
      if (isObject(raw) && raw.enabled === false) continue
      add(fromOpencode(name, raw), 'opencode config')
    }
    return
  }
}

// Every distinct server found, deduped by name + URL (or command for local
// servers) so a server listed for two projects shows once, while two different
// servers that happen to share a name both survive. Claude comes first.
export function discoverMcpServers(): DiscoveredMcpServer[] {
  const found: DiscoveredMcpServer[] = []
  const seen = new Set<string>()
  const claudeNames = claudeAuthenticatedServers()
  const opencodeNames = opencodeAuthenticatedServers()
  const push = (source: string) => (server: McpServer | undefined, scope: string) => {
    if (!server) return
    const name = server.name.trim()
    if (!name) return
    const target = server.transport === 'stdio' ? server.command.trim() : server.url.trim()
    const key = `${name.toLowerCase()}\u0000${target.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    const authenticated = (source === 'Claude Code' ? claudeNames : opencodeNames).has(name.toLowerCase())
    found.push({ server, source, scope, authenticated })
  }
  discoverClaude(push('Claude Code'))
  discoverOpencode(push('opencode'))
  return found
}
