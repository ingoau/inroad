import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { z } from 'zod'
import { mcpServerKey } from '../shared/api'
import type {
  AgentQuestion,
  ChatRequest,
  ChatResult,
  ClaudeProgress,
  DraftRequest,
  DraftResult,
  EmailComment,
  EmailGuidance,
  EventAnswersRequest,
  EventLookupRequest,
  EventLookupResult,
  LeadSuggestionsRequest,
  McpAuthStatus,
  McpServer,
  ParsedOrganisation,
  ProposedEdit,
  ResearchRequest,
  ResearchResult,
  Result,
  VoiceInput,
  VoiceLearnRequest,
  VoiceLearnResult,
  WritingRulesRequest,
} from '../shared/api'
import { opencodeAuthFile, opencodeAuthenticatedServers } from './mcp'
import type { AiConfig } from './settings'

// Runs Inroad's agent tasks through the opencode CLI instead of the Claude
// Agent SDK. opencode's non-interactive `run` hides the question tool behind a
// hardcoded deny rule, so Inroad talks to a background `opencode serve` over its
// HTTP API instead: it creates a session per run, streams events, and translates
// them into the same progress/result shapes the Claude backend produces. The
// user's own opencode install and model providers are used, through a
// locked-down agent (see projectConfig) so runs stay web-only.

type Emit = (p: ClaudeProgress) => void

type OpencodeConfig = AiConfig['opencode']

const toRecord = (pairs: { key: string; value: string }[]) =>
  Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]))

// MCP servers the user enabled in Settings, refreshed before each run. They're
// written into the workspace config below so opencode connects to them.
let mcpServers: McpServer[] = []
export function setMcpServers(servers: McpServer[]) {
  mcpServers = servers
}

// A project-local opencode config written into the agent workspace. Its "inroad"
// agent is read-only and web-only: every tool is denied except web search, page
// fetches, and any MCP servers the user added. A step cap makes it answer once
// it has enough instead of looping on tool calls.
const BASE_PERMISSION = {
  '*': 'deny',
  read: 'deny',
  edit: 'deny',
  glob: 'deny',
  grep: 'deny',
  list: 'deny',
  bash: 'deny',
  task: 'deny',
  todowrite: 'deny',
  external_directory: 'deny',
  // The agent may pause and ask the user something. Individual runs can still
  // deny this at the session level (see runSession).
  question: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
} as const

function projectConfig(servers: McpServer[] = mcpServers) {
  const mcp: Record<string, unknown> = {}
  // Later keys win, so the per-server allows are added after the catch-all deny.
  const permission: Record<string, unknown> = { ...BASE_PERMISSION }
  for (const s of servers) {
    if (!s.enabled || !s.name.trim()) continue
    const key = mcpServerKey(s)
    if (s.transport === 'stdio') {
      if (!s.command.trim()) continue
      const environment = toRecord(s.env)
      mcp[key] = { type: 'local', command: [s.command.trim(), ...s.args.filter((a) => a.trim())], enabled: true, ...(Object.keys(environment).length ? { environment } : {}) }
    } else {
      if (!s.url.trim()) continue
      const headers = toRecord(s.headers)
      mcp[key] = { type: 'remote', url: s.url.trim(), enabled: true, ...(Object.keys(headers).length ? { headers } : {}) }
    }
    // opencode names MCP tools "<server>_<tool>"; this lets the agent call them.
    permission[`${key}_*`] = 'allow'
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    ...(Object.keys(mcp).length ? { mcp } : {}),
    agent: {
      inroad: {
        description: "Inroad's research and writing agent. Web search and page reads only.",
        mode: 'primary',
        steps: 24,
        permission,
      },
    },
  }
}

// Writes the workspace config. Sign-in passes a list with the target server
// force-enabled, so an auth attempt works even if the server is switched off.
// Returns the JSON so callers can hash it and restart the server when it changes.
function ensureProjectConfig(workspace: string, servers: McpServer[] = mcpServers): string {
  mkdirSync(workspace, { recursive: true })
  const file = join(workspace, 'opencode.json')
  const json = `${JSON.stringify(projectConfig(servers), null, 2)}\n`
  try {
    if (readFileSync(file, 'utf8') === json) return json
  } catch {
    // No config yet, or unreadable: write a fresh one below.
  }
  writeFileSync(file, json)
  return json
}

// --------------------------------------------------------------- running

interface Handlers {
  onText?: (text: string) => void
  onTool?: (tool: string, input: Record<string, unknown> | undefined) => void
  // Called before a retry with the fallback model, after the primary failed.
  onFallback?: (model: string) => void
}

// Per-run options: whether this run may ask the user questions, and the label
// shown alongside them (e.g. "Researching Canva").
interface RunOptions {
  allowQuestions?: boolean
  context?: string
}

// A question opencode is waiting on. `id` is opencode's own request id.
interface QuestionAsked {
  id: string
  sessionID: string
  questions?: { question: string; header?: string; options?: { label: string; description?: string }[]; multiple?: boolean; custom?: boolean }[]
}

// The renderer answers questions through this; set by the main process. When
// it's unset (or a run denies questions) the run skips them instead.
export interface QuestionRequest {
  requestId: string
  context: string
  questions: AgentQuestion[]
}
type QuestionHandler = (req: QuestionRequest) => Promise<string[][]>
let questionHandler: QuestionHandler | undefined
export function setQuestionHandler(fn: QuestionHandler | undefined) {
  questionHandler = fn
}

// ---- background server ----

// One `opencode serve` process, reused across runs for the same executable and
// workspace. It restarts if the workspace config changes (e.g. a new MCP server).
interface RunningServer {
  key: string
  base: string
  token: string
  workspace: string
  child: ChildProcess
  configHash: string
}

let runningServer: RunningServer | null = null
// Serialises startup so concurrent runs (e.g. fan-out research) share one server.
let serverStart: Promise<RunningServer> | null = null

const serverKey = (cfg: OpencodeConfig) => `${cfg.executable}\u0000${cfg.workspace}`

// opencode serve authenticates with HTTP Basic, username "opencode".
const authHeader = (token: string) => `Basic ${Buffer.from(`opencode:${token}`).toString('base64')}`

// A free localhost port, found by binding to :0 and releasing it.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('Couldn’t find a free port.'))))
    })
  })
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function getServer(cfg: OpencodeConfig, configHash: string): Promise<RunningServer> {
  const key = serverKey(cfg)
  // Wait out any in-flight start (a parallel run may already be bringing one up).
  if (serverStart) {
    try {
      await serverStart
    } catch {
      // That start failed; fall through and try again below.
    }
  }
  if (runningServer && runningServer.key === key && runningServer.configHash === configHash && runningServer.child.exitCode === null) return runningServer
  if (runningServer) disposeOpencode()

  const start = (async () => {
    const port = await freePort()
    const token = randomBytes(24).toString('hex')
    const child = spawn(cfg.executable, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: cfg.workspace,
      env: { ...process.env, OPENCODE_SERVER_PASSWORD: token, PWD: cfg.workspace },
    })
    const state: { error?: NodeJS.ErrnoException } = {}
    child.on('error', (err) => (state.error = err as NodeJS.ErrnoException))
    child.on('exit', () => {
      if (runningServer?.child === child) runningServer = null
    })

    const server: RunningServer = { key, base: `http://127.0.0.1:${port}`, token, workspace: cfg.workspace, child, configHash }
    runningServer = server
    await waitReady(server, state)
    return server
  })()
  serverStart = start
  try {
    return await start
  } finally {
    if (serverStart === start) serverStart = null
  }
}

async function waitReady(server: RunningServer, state: { error?: NodeJS.ErrnoException }): Promise<void> {
  const executable = server.key.split('\u0000')[0]
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (state.error)
      throw state.error.code === 'ENOENT'
        ? new Error(`Couldn’t find opencode at “${executable}”. Install opencode or set its path in Settings.`)
        : new Error(state.error.message)
    if (server.child.exitCode !== null) throw new Error('opencode serve stopped before it was ready.')
    try {
      const res = await fetch(`${server.base}/config?directory=${encodeURIComponent(server.workspace)}`, { headers: { authorization: authHeader(server.token) } })
      if (res.ok) return
    } catch {
      // Not listening yet; keep polling.
    }
    await wait(250)
  }
  throw new Error('opencode took too long to start. Try again.')
}

// Kills the background server. Call when the app quits.
export function disposeOpencode() {
  if (!runningServer) return
  const child = runningServer.child
  runningServer = null
  try {
    child.kill()
  } catch {
    // Already gone.
  }
}

// ---- HTTP + events ----

// Sends one request to the server, scoped to the workspace. Returns parsed JSON
// (or the raw text for endpoints that reply with an empty body).
async function request(server: RunningServer, path: string, init?: RequestInit): Promise<unknown> {
  const url = `${server.base}${path}${path.includes('?') ? '&' : '?'}directory=${encodeURIComponent(server.workspace)}`
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: authHeader(server.token), ...(init?.headers ?? {}) },
  })
  const body = await res.text()
  if (!res.ok) throw new Error(body.trim() || `opencode request failed (${res.status}).`)
  if (!body) return null
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

// "provider/model" → the shape the API wants. Model ids may contain slashes.
function splitModel(model: string): { providerID: string; modelID: string } | undefined {
  const i = model.indexOf('/')
  return i < 0 ? undefined : { providerID: model.slice(0, i), modelID: model.slice(i + 1) }
}

// Runs one prompt on one model: creates a session, subscribes to its events,
// prompts it, and collects assistant text until the session goes idle. Failed
// runs surface as a thrown error (opencode reports errors only over the stream).
async function runSession(cfg: OpencodeConfig, model: string | undefined, prompt: string, handlers: Handlers = {}, opts: RunOptions = {}): Promise<string> {
  const configHash = ensureProjectConfig(cfg.workspace)
  const server = await getServer(cfg, configHash)

  // With questions denied, opencode hides the question tool for this session.
  const permission = opts.allowQuestions === false ? [{ permission: 'question', action: 'deny', pattern: '*' }] : undefined
  const session = (await request(server, '/session', { method: 'POST', body: JSON.stringify(permission ? { permission } : {}) })) as { id: string }
  const sessionID = session.id

  const controller = new AbortController()
  const partOrder: string[] = []
  const partText = new Map<string, string>()
  const emittedText = new Map<string, string>()
  const seenTools = new Set<string>()
  const assistants = new Set<string>()
  let failure: string | undefined

  const deleteSession = () => request(server, `/session/${sessionID}`, { method: 'DELETE' }).catch(() => {})

  // Replies to one asked question, through the renderer if allowed.
  const answerQuestion = async (q: QuestionAsked) => {
    const asked = q.questions ?? []
    let answers: string[][] = []
    if (opts.allowQuestions !== false && questionHandler) {
      const questions: AgentQuestion[] = asked.map((x) => ({
        question: x.question,
        header: x.header,
        options: (x.options ?? []).map((o) => ({ label: o.label, description: o.description })),
        multiple: x.multiple,
        custom: x.custom,
      }))
      try {
        answers = await questionHandler({ requestId: q.id, context: opts.context ?? '', questions })
      } catch {
        answers = []
      }
    }
    const normalized = asked.map((_, i) => answers[i] ?? [])
    await request(server, `/question/${q.id}/reply`, { method: 'POST', body: JSON.stringify({ answers: normalized }) }).catch(() => {})
  }

  // Handles one stream event; returns true when this session has gone idle.
  const onEvent = async (ev: { type?: string; properties?: any }): Promise<boolean> => {
    const p = ev.properties ?? {}
    const sid: string | undefined = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID
    if (sid && sid !== sessionID) return false
    switch (ev.type) {
      case 'message.updated': {
        const info = p.info
        if (info?.id && (!info.sessionID || info.sessionID === sessionID)) {
          if (info.role === 'assistant') assistants.add(info.id)
        }
        return false
      }
      case 'message.part.updated': {
        const part = p.part
        if (!part) return false
        if (part.type === 'text' && typeof part.text === 'string') {
          // Only the assistant's words; the user's own prompt is a text part too.
          if (part.messageID && !assistants.has(part.messageID)) return false
          if (!partText.has(part.id)) partOrder.push(part.id)
          partText.set(part.id, part.text)
          const prev = emittedText.get(part.id) ?? ''
          if (part.text.length > prev.length && part.text.startsWith(prev)) {
            const delta = part.text.slice(prev.length)
            if (delta) handlers.onText?.(delta)
          }
          emittedText.set(part.id, part.text)
        } else if (part.type === 'tool' && part.tool && part.tool !== 'question') {
          // Emit once per tool call, when it starts.
          if (!seenTools.has(part.id) && (part.state?.status === 'running' || part.state?.status === 'pending')) {
            seenTools.add(part.id)
            handlers.onTool?.(part.tool, part.state?.input)
          }
        }
        return false
      }
      case 'question.asked': {
        const q = p as QuestionAsked
        if (q.sessionID !== sessionID) return false
        handlers.onTool?.('question', undefined)
        await answerQuestion(q)
        return false
      }
      case 'session.error': {
        failure ??= p.error?.data?.message ?? p.error?.name ?? 'opencode reported an error.'
        return false
      }
      case 'session.status':
        return p.status?.type === 'idle'
      default:
        return false
    }
  }

  // Subscribe before prompting so no event is missed.
  let res: Response
  try {
    res = await fetch(`${server.base}/event?directory=${encodeURIComponent(server.workspace)}`, {
      headers: { authorization: authHeader(server.token), accept: 'text/event-stream' },
      signal: controller.signal,
    })
  } catch (err) {
    await deleteSession()
    throw err
  }
  if (!res.ok || !res.body) {
    await deleteSession()
    throw new Error(`opencode event stream failed (${res.status}).`)
  }

  const split = model ? splitModel(model) : undefined
  const promptBody = {
    parts: [{ type: 'text', text: prompt }],
    ...(split ? { model: split } : {}),
    ...(cfg.agent ? { agent: cfg.agent } : {}),
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let idle = false
  try {
    await request(server, `/session/${sessionID}/prompt_async`, { method: 'POST', body: JSON.stringify(promptBody) })
    while (!idle) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data: ')) continue
        let ev: { type?: string; properties?: any }
        try {
          ev = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        if (process.env.INROAD_DEBUG_OPENCODE) console.error('[opencode]', line.slice(0, 600))
        idle = (await onEvent(ev)) || idle
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }

  await deleteSession()
  if (failure) throw new Error(failure)
  return partOrder.map((id) => partText.get(id) ?? '').join('')
}

// Which flow a run belongs to, so it can use that flow's model when set.
type Task = 'research' | 'chat' | 'default'

// The primary model for a task: its own override, else the default model.
function primaryModel(cfg: OpencodeConfig, task: Task): string | undefined {
  if (task === 'research') return cfg.researchModel || cfg.model
  if (task === 'chat') return cfg.chatModel || cfg.model
  return cfg.model
}

// Runs with the task's model, and if that fails — a provider out of usage,
// rate-limited, unreachable — tries the fallback model once. Set models and the
// fallback in Settings → AI agent (e.g. a free router first, a paid one as backup).
async function run(cfg: OpencodeConfig, prompt: string, handlers: Handlers = {}, task: Task = 'default', opts: RunOptions = {}): Promise<string> {
  const primary = primaryModel(cfg, task)
  try {
    return await runSession(cfg, primary, prompt, handlers, opts)
  } catch (err) {
    if (!cfg.fallbackModel || cfg.fallbackModel === primary) throw err
    handlers.onFallback?.(cfg.fallbackModel)
    return await runSession(cfg, cfg.fallbackModel, prompt, handlers, opts)
  }
}

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ------------------------------------------------- structured output

// opencode has no schema-constrained output flag, so ask for JSON in the prompt
// and validate it before trusting it (the same schemas the Claude backend uses).
function withJsonSchema(schema: z.ZodType): string {
  const { $schema: _drop, ...json } = z.toJSONSchema(schema) as Record<string, unknown>
  return `\n\nReply with a single JSON object matching this JSON Schema exactly. Output only the JSON — no prose, no explanations, no markdown code fences.\n<json_schema>\n${JSON.stringify(json)}\n</json_schema>`
}

// Finds the outermost `{...}` objects in text, respecting strings and escapes,
// so braces inside a quoted URL or sentence don't confuse the scan.
function jsonObjects(text: string): string[] {
  const out: string[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1))
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return out
}

function parseJson<S extends z.ZodType>(schema: S, text: string): z.infer<S> {
  const candidates: string[] = []
  // Any fenced blocks first (the model may wrap JSON in ``` even when told not to).
  const fence = /```(?:json|jsonc)?\s*([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  while ((match = fence.exec(text))) candidates.push(match[1])
  // Then every brace-balanced object, in case prose or fences got in the way.
  candidates.push(...jsonObjects(text))

  const problems: string[] = []
  for (const candidate of candidates) {
    let value: unknown
    try {
      value = JSON.parse(candidate.trim())
    } catch (err) {
      problems.push(err instanceof Error ? err.message : 'invalid JSON')
      continue
    }
    const parsed = schema.safeParse(value)
    if (parsed.success) return parsed.data
    problems.push(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '))
  }

  // Nothing parsed: keep the raw answer in the log so the failure is diagnosable.
  console.error(`[opencode] structured output not understood (${problems[0] ?? 'no JSON found'}):\n${text.slice(0, 4000)}`)
  throw new Error('The AI’s answer didn’t come back in the expected format. Try again.')
}

// ------------------------------------------------------- shared prompts

function voiceSection(voice: VoiceInput) {
  const notes = voice.notes.length ? voice.notes.map((n) => `- ${n}`).join('\n') : '(no notes yet)'
  const examples = voice.examples
    .map((e, i) =>
      e.draft
        ? `<example index="${i + 1}">\n<claude_draft>\n${e.draft}\n</claude_draft>\n<as_sent>\n${e.final}\n</as_sent>\n</example>`
        : `<example index="${i + 1}">\n<written_by_user>\n${e.final}\n</written_by_user>\n</example>`,
    )
    .join('\n')
  return `<voice name="${voice.name}">\n<style_notes>\n${notes}\n</style_notes>\n${examples ? `<examples>\n${examples}\n</examples>\n` : ''}</voice>`
}

const BriefSchema = z.object({
  summary: z.string().describe('One or two sentences on who they are and why they matter for this campaign.'),
  sections: z
    .array(z.object({ title: z.string(), items: z.array(z.string()) }))
    .describe('2–4 short sections whose headings suit the campaign, e.g. "Why they’d sponsor", "Past sponsorships", "Capacity & facilities".'),
  recipients: z.array(
    z.object({
      name: z.string().describe('Person’s name, or a description like "Partnerships inbox".'),
      role: z.string(),
      email: z.string().describe('Empty string if no address was found.'),
      confidence: z.enum(['high', 'medium', 'low']),
      source: z.string().describe('How this was found.'),
    }),
  ),
  sources: z.array(z.object({ title: z.string(), url: z.string() })),
})

const MARKDOWN = `Blank line between paragraphs; a single newline is a line break (e.g. between sign-off lines). **bold** and *italic* sparingly, [link text](https://url) for links, "- " or "1. " for lists, "> " for quotes. No headings, tables, images or HTML.`

const COMMENT_KINDS = `"verify" flags something the user should double-check before sending: a number, name, date or claim you couldn't confirm, or a guessed contact. "note" explains a choice, e.g. why you opened with a particular hook or why a detail is in there.`

const CommentSchema = z.object({
  quote: z
    .string()
    .describe('Exact text from the email body, copied verbatim (including markdown), within a single paragraph. Keep it short: the phrase the comment is about.'),
  comment: z.string().describe('One short sentence for the user.'),
  kind: z.enum(['verify', 'note']),
})

// Only keep comments whose quote really is in the body.
const anchored = (body: string, comments: EmailComment[]) => comments.filter((c) => c.quote.trim() && body.includes(c.quote))

const EmailFields = {
  to: z.string().describe('Email of the single best recipient, or empty string if none has an address.'),
  subject: z.string(),
  body: z.string().describe(`The email body in markdown. ${MARKDOWN}`),
  comments: z
    .array(CommentSchema)
    .describe(`1–4 comments on specific phrases of the body, for the user reviewing it. ${COMMENT_KINDS} Flag anything uncertain; skip the obvious.`),
}

// The campaign's email format and the user's note about this organisation:
// firm requirements, unlike the softer campaign notes and voice.
function guidanceSections(req: EmailGuidance & { company: string }) {
  return [
    req.emailFormat?.trim() ? `<email_format>\nEvery email in this campaign must follow this:\n${req.emailFormat.trim()}\n</email_format>` : '',
    req.orgNote?.trim() ? `<user_instructions organisation="${req.company}">\n${req.orgNote.trim()}\n</user_instructions>` : '',
  ].filter(Boolean)
}

const GUIDANCE_RULE = `If there's an email format, follow its structure and include everything it asks for. If the user gave instructions for this organisation, follow them exactly; they override the campaign notes, the format and your own judgement where they conflict.`

const ResearchDraftSchema = z.object({
  research_notes: z.string().describe('Everything useful you found, each fact with its source URL. Kept so the email can be rewritten later without searching again.'),
  brief: BriefSchema,
  ...EmailFields,
})

const WRITING_RULES = `Write the email exactly as the user writes: follow their style notes, and treat the examples (Claude's draft vs. what they actually sent) as the strongest signal of their preferences. Use only facts from your research; never invent details, numbers, people or email addresses. Open with something specific to this organisation, make one clear ask drawn from the campaign notes, and keep it short enough to read on a phone. Address the best recipient by first name when you have one. ${GUIDANCE_RULE}`

const RESEARCH_SYSTEM = `You research an organisation and write the user a personalised first-contact email to it. The user's campaign notes say what they're reaching out about and what to look for.

Research with web search and page fetches: what the organisation does; why they'd be a good fit for what the campaign asks for; recent, specific things that would open the email well; and the best people or inboxes to contact. A handful of searches and a few page reads is usually enough. Only give an email address if it's published or very strongly evidenced, and say how you know.

${WRITING_RULES}`

// A one-line description of what a tool call is doing, for the progress log.
function describeTool(tool: string, input: Record<string, unknown> | undefined): string | undefined {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const query = str(input?.query)
  const url = str(input?.url)
  const path = str(input?.filePath) ?? str(input?.path)
  switch (tool) {
    case 'websearch':
      return `Searched “${query ?? 'the web'}”`
    case 'webfetch':
      return url ? `Read ${url.replace(/^https?:\/\//, '')}` : 'Read a page'
    case 'read':
      return path ? `Read ${path}` : undefined
    case 'question':
      return 'Asked you a question'
    default: {
      // User-added MCP tools are named "<server>_<tool>"; name the server.
      const server = mcpServers.find((s) => s.enabled && tool.startsWith(`${mcpServerKey(s)}_`))
      if (server) return `Checked ${server.name}`
      return tool.startsWith('mcp') ? `Checked ${tool}` : undefined
    }
  }
}

// ------------------------------------------------- fan-out research sub-agents

// When a sub-agent model is set (Settings → AI agent), research splits into
// three parallel sub-agent runs — one per angle — and a final pass writes the
// brief and email from their combined notes. Each sub-agent streams its own
// steps to the UI, where they show side by side.
const RESEARCH_ANGLES = [
  {
    label: 'Overview',
    focus: 'What the organisation does, its size and reach, where it operates, and what it cares about or supports.',
  },
  {
    label: 'Fit & history',
    focus: `Past sponsorships, partnerships, grants or community programmes, and anything suggesting they'd say yes to what the campaign asks for.`,
  },
  {
    label: 'News & contacts',
    focus: 'Recent news, launches or achievements worth opening the email with, and the best people or inboxes to contact (names, roles, and email addresses only where published).',
  },
]

const SubagentResearchSchema = z.object({
  notes: z.string().describe('Everything useful you found for this angle, one fact per line, each with the URL it came from.'),
  sources: z.array(z.object({ title: z.string(), url: z.string() })).describe('The pages you actually read.'),
})

// One sub-agent's prompt: the shared research brief narrowed to its angle.
function subagentPrompt(angle: (typeof RESEARCH_ANGLES)[number], req: ResearchRequest): string {
  return [
    `You research one angle of an organisation so the user can write them a first-contact outreach email. Other sub-agents cover the other angles in parallel, so stay strictly on yours. Research with web search and page fetches; a handful of searches and a few page reads is enough. Only give an email address if it's published or very strongly evidenced. Never invent details, numbers, people or addresses.`,
    `<campaign_notes>\n${req.campaignNotes || '(none)'}\n</campaign_notes>`,
    req.orgNote?.trim() ? `<user_instructions organisation="${req.company}">\n${req.orgNote.trim()}\n</user_instructions>` : '',
    `Organisation: ${req.company}${req.website ? ` (website: ${req.website})` : ''}`,
    `Your angle: ${angle.label} — ${angle.focus}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

// Runs the angle sub-agents in parallel on the sub-agent model and merges what
// they found into one set of research notes. Returns null when every sub-agent
// failed, so the caller can fall back to the single-run research path. A
// sub-agent that fails on its own is skipped rather than failing the research.
async function fanOutResearch(cfg: OpencodeConfig, model: string, req: ResearchRequest, emit: Emit): Promise<string | null> {
  const runs = await Promise.all(
    RESEARCH_ANGLES.map(async (angle, index) => {
      const report = (text: string, done?: boolean) => emit({ jobId: req.jobId, kind: 'subagent', subagent: index, label: angle.label, text, done })
      try {
        const text = await runSession(cfg, model, subagentPrompt(angle, req) + withJsonSchema(SubagentResearchSchema), {
          onTool: (tool, input) => {
            const step = describeTool(tool, input)
            if (step) report(step)
          },
        }, { allowQuestions: false, context: `Researching ${req.company}` })
        const out = parseJson(SubagentResearchSchema, text)
        report(`Done · ${out.sources.length} source${out.sources.length === 1 ? '' : 's'}`, true)
        return out
      } catch (err) {
        report(`Failed — ${err instanceof Error ? err.message : String(err)}`, true)
        return null
      }
    }),
  )
  const found = runs.flatMap((r, i) => (r ? [{ angle: RESEARCH_ANGLES[i], out: r }] : []))
  if (!found.length) return null
  const sources: { title: string; url: string }[] = []
  const seen = new Set<string>()
  for (const { out } of found)
    for (const s of out.sources) {
      const url = s.url.trim()
      if (url && !seen.has(url)) {
        seen.add(url)
        sources.push(s)
      }
    }
  return `${found.map(({ angle, out }) => `## ${angle.label}\n${out.notes.trim()}`).join('\n\n')}\n\n## Sources\n${sources.map((s) => `- ${s.title} — ${s.url}`).join('\n')}`
}

// ------------------------------------------------- research + first draft

export async function researchAndDraft(cfg: OpencodeConfig, req: ResearchRequest, emit: Emit): Promise<Result<ResearchResult>> {
  return guard(async () => {
    emit({ jobId: req.jobId, kind: 'step', text: `Researching ${req.company}` })
    if (cfg.subAgentModel) {
      const merged = await fanOutResearch(cfg, cfg.subAgentModel, req, emit)
      if (merged) {
        emit({ jobId: req.jobId, kind: 'step', text: 'Writing draft from combined research' })
        // The drafting pass runs on the main research model (with its fallback),
        // from notes only — the searching already happened in parallel.
        const res = await draft(cfg, {
          company: req.company,
          campaignNotes: req.campaignNotes,
          emailFormat: req.emailFormat,
          orgNote: req.orgNote,
          voice: req.voice,
          senderName: req.senderName,
          research: merged,
        })
        if (!res.ok) throw new Error(res.error)
        return { research: merged, draft: res.value }
      }
      emit({ jobId: req.jobId, kind: 'step', text: 'Sub-agents didn’t return; researching in one pass' })
    }
    const prompt = [
      RESEARCH_SYSTEM,
      `<campaign_notes>\n${req.campaignNotes || '(none)'}\n</campaign_notes>`,
      ...guidanceSections(req),
      voiceSection(req.voice),
      `<sender>${req.senderName || 'the user'}</sender>`,
      `Organisation: ${req.company}${req.website ? ` (website: ${req.website})` : ''}`,
    ].join('\n\n')
    const text = await run(cfg, prompt + withJsonSchema(ResearchDraftSchema), {
      onTool: (tool, input) => {
        const step = describeTool(tool, input)
        if (step) emit({ jobId: req.jobId, kind: 'step', text: step })
      },
      onFallback: (model) => emit({ jobId: req.jobId, kind: 'step', text: `Trying fallback model ${model}` }),
    }, 'research', { allowQuestions: true, context: `Researching ${req.company}` })
    emit({ jobId: req.jobId, kind: 'step', text: 'Writing draft' })
    const out = parseJson(ResearchDraftSchema, text)
    return {
      research: out.research_notes,
      draft: { brief: out.brief, to: out.to, subject: out.subject, body: out.body, comments: anchored(out.body, out.comments) },
    }
  })
}

// ---------------------------------------------- redraft from saved research

const DraftSchema = z.object({ brief: BriefSchema, ...EmailFields })

export async function draft(cfg: OpencodeConfig, req: DraftRequest): Promise<Result<DraftResult>> {
  return guard(async () => {
    const prompt = [
      `You write first-contact outreach emails for the user, from research that's already been done. Also turn the research into a brief for the user to skim, and pick the best recipient. Do not use any tools.\n\n${WRITING_RULES}`,
      `<campaign_notes>\n${req.campaignNotes || '(none)'}\n</campaign_notes>`,
      ...guidanceSections(req),
      voiceSection(req.voice),
      `<sender>${req.senderName || 'the user'}</sender>`,
      `<organisation>${req.company}</organisation>`,
      `<research_notes>\n${req.research}\n</research_notes>`,
      req.previousDraft
        ? `Write a fresh version that takes a noticeably different angle from this previous draft:\n<previous_draft>\n${req.previousDraft}\n</previous_draft>`
        : 'Write the brief and the email.',
    ].join('\n\n')
    const out = parseJson(DraftSchema, await run(cfg, prompt + withJsonSchema(DraftSchema), {}, 'research', { allowQuestions: false }))
    return { ...out, comments: anchored(out.body, out.comments) }
  })
}

// ------------------------------------------------------------------- chat

const CHAT_SYSTEM = `You help the user refine one outreach email. You can see the email, the research brief, the campaign notes, any email format and instructions for this organisation, and the user's voice. Keep the email within the format and instructions unless the user asks otherwise.

The email body is markdown, exactly as stored: ${MARKDOWN} Links and formatting are part of the text you see and can change.

To change the email, quote the exact text to replace (copied verbatim from the subject or body, long enough to be unique, within a single paragraph) and give the replacement. To delete something, quote it with a few surrounding words and leave those words in the replacement. Prefer a few focused edits over rewriting everything, and stay in the user's voice. When the user asks what you think, wants something checked, or asks why something is there, pin a comment to the phrase it's about rather than only describing it in your reply. Don't repeat comments the email already has. Only search the web if the user asks for something the brief doesn't cover. Keep your messages short.

When you have edits or comments, end your reply with ONE fenced JSON block in exactly this shape and nothing after it:
\`\`\`json
{"edits":[{"old":"text to replace","new":"replacement text","reason":"a few words on why"}],"comments":[{"quote":"text from the body","comment":"one short sentence","kind":"verify"}]}
\`\`\`
Each "old" must appear verbatim in the subject or body, and each comment's "quote" must appear verbatim in the body. Omit either array when it's empty. If you don't want to change anything, omit the block entirely. The block is machine-read: don't refer to it in your prose.

Reply directly as the assistant. If you're running as a read-only or plan agent, don't mention that, don't announce modes, and don't list the edits in prose — just make the changes via the block.`

const EditSchema = z.object({ old: z.string().min(1), new: z.string().min(1), reason: z.string() })
const EditsSchema = z.object({
  edits: z.array(EditSchema).default([]),
  comments: z.array(CommentSchema).default([]),
})

// Pulls the trailing edits block out of the reply, keeping only edits whose
// quoted text really exists in the email (the same check the Claude backend does).
function takeEdits(
  text: string,
  subject: string,
  body: string,
): { text: string; proposals: ProposedEdit[]; comments: EmailComment[] } {
  const re = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi
  let match: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((match = re.exec(text))) last = match
  if (!last) return { text: text.trim(), proposals: [], comments: [] }
  let proposals: ProposedEdit[] = []
  let comments: EmailComment[] = []
  try {
    const parsed = EditsSchema.safeParse(JSON.parse(last[1]))
    if (parsed.success) {
      proposals = parsed.data.edits.filter((e) => body.includes(e.old) || subject.includes(e.old))
      comments = anchored(body, parsed.data.comments)
    }
  } catch {
    return { text: text.trim(), proposals: [], comments: [] }
  }
  const cleaned = (text.slice(0, last.index) + text.slice(last.index + last[0].length)).trim()
  return { text: cleaned, proposals, comments }
}

export async function chat(cfg: OpencodeConfig, req: ChatRequest, emit: Emit): Promise<Result<ChatResult>> {
  return guard(async () => {
    const context = [
      CHAT_SYSTEM,
      `<campaign_notes>\n${req.campaignNotes || '(none)'}\n</campaign_notes>`,
      ...guidanceSections(req),
      voiceSection(req.voice),
      req.comments?.length
        ? `<comments_on_email>\n${req.comments.map((c) => `- [${c.kind}] "${c.quote}": ${c.comment}`).join('\n')}\n</comments_on_email>`
        : '',
      req.brief ? `<brief organisation="${req.company}">\n${JSON.stringify(req.brief)}\n</brief>` : '',
      `<email>\nSubject: ${req.subject}\n\n${req.body}\n</email>`,
    ]
      .filter(Boolean)
      .join('\n\n')
    const transcript = req.history.length
      ? `<conversation_so_far>\n${req.history.map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`).join('\n\n')}\n</conversation_so_far>\n\n`
      : ''

    let streamed = ''
    const text = await run(cfg, `${context}\n\n${transcript}User: ${req.message}`, {
      onText: (chunk) => {
        streamed += chunk
        emit({ jobId: req.jobId, kind: 'delta', text: chunk })
      },
      onFallback: (model) => emit({ jobId: req.jobId, kind: 'step', text: `Trying fallback model ${model}` }),
    }, 'chat', { allowQuestions: true, context: `Chatting about ${req.company}` })
    const full = text.trim() || streamed.trim()
    const { text: reply, proposals, comments } = takeEdits(full, req.subject, req.body)
    return { text: reply, proposals, comments }
  })
}

// ------------------------------------------------------------- voice learning

const VoiceSchema = z.object({
  add: z.array(z.string()).describe('New style notes: short, imperative, general. At most 3.'),
  remove: z.array(z.string()).describe('Existing notes that the edits clearly contradict, quoted exactly.'),
})

export async function learnVoice(cfg: OpencodeConfig, req: VoiceLearnRequest): Promise<Result<VoiceLearnResult>> {
  return guard(async () => {
    const prompt = [
      `You maintain a short style guide describing how one person writes outreach emails. You're given Claude's draft and the version they actually saved. Do not use any tools.\n\nExtract only general, reusable preferences: tone, length, structure, openers and sign-offs, words or phrases they add or avoid. Ignore edits about this particular organisation's facts. Don't repeat anything the existing notes already say. If nothing general changed, return empty lists.`,
      `<existing_notes voice="${req.voiceName}">\n${req.notes.map((n) => `- ${n}`).join('\n') || '(none)'}\n</existing_notes>`,
      `<claude_draft>\n${req.draft}\n</claude_draft>`,
      `<as_saved>\n${req.final}\n</as_saved>`,
    ].join('\n\n')
    const text = await run(cfg, prompt + withJsonSchema(VoiceSchema), {}, 'default', { allowQuestions: false })
    const out = parseJson(VoiceSchema, text)
    return { add: out.add.slice(0, 3), remove: out.remove.filter((r) => req.notes.includes(r)) }
  })
}

// ------------------------------------------------------------ event lookup

const EventSchema = z.object({
  details: z
    .string()
    .describe(
      'Plain-text notes about the event for writing outreach emails: what it is, dates, place, who attends and how many, history and past numbers, what the organisers are asking partners for (tiers, prices, perks), who runs it, links. Short lines, no markdown headings.',
    ),
  questions: z
    .array(
      z.object({
        question: z.string().describe('One short question for the user.'),
        options: z.array(z.string()).describe('2–4 likely answers (e.g. the conflicting values you found), or [] if open-ended.'),
      }),
    )
    .describe(
      'Up to 4 questions about things only the user can settle and that matter for outreach: conflicting figures, or a key fact you couldn’t find (dates, place, what they’re asking for). [] if none.',
    ),
})

export async function lookupEvent(cfg: OpencodeConfig, req: EventLookupRequest, emit: Emit): Promise<Result<EventLookupResult>> {
  return guard(async () => {
    emit({ jobId: req.jobId, kind: 'step', text: `Looking for “${req.name}”` })
    const prompt = [
      `The user organises the event named below and is setting up an app that writes outreach emails (sponsors, venues, partners) for it. Find what's known about the event so they don't have to type it out.

Search the web for the event: its own site and social posts, who runs it, dates, venue, who attends and roughly how many, past editions and numbers, and what organisers ask partners for. Only read pages; never submit a form, post, sign up or change anything. Stop once you have a clear picture; a dozen or so page reads is plenty.

Only report what you found. If sources disagree on something that matters, don't explain it in the details: ask the user instead. If you find nothing, leave the details empty and ask what the event is. Never write "unknown": leave a fact out, or ask about it if it matters.

Leave out: sources, citations and where you found anything; outreach already sent or drafted and sponsors already confirmed; other people working on the event and their contact details; internal logistics (insurance, budget, hire agreements, to-dos); notes about tools or access. Public links to the event's own site or social pages are fine.`,
      `Event: ${req.name}${req.hint ? `\nWhat the user added: ${req.hint}` : ''}`,
    ].join('\n\n')
    const text = await run(cfg, prompt + withJsonSchema(EventSchema), {
      onTool: (tool, input) => {
        const step = describeTool(tool, input)
        if (step) emit({ jobId: req.jobId, kind: 'step', text: step })
      },
      onFallback: (model) => emit({ jobId: req.jobId, kind: 'step', text: `Trying fallback model ${model}` }),
    }, 'research', { allowQuestions: true, context: `Looking into ${req.name}` })
    const out = parseJson(EventSchema, text)
    return { details: out.details, questions: out.questions.filter((q) => q.question.trim()).slice(0, 4) }
  })
}

// Folds the user's answers into the event details, leaving the rest alone.
export async function applyEventAnswers(cfg: OpencodeConfig, req: EventAnswersRequest): Promise<Result<{ details: string }>> {
  return guard(async () => {
    const qa = req.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n')
    const prompt = [
      `Update the event details with the user's answers to your questions. Change only what the answers affect: add or correct those facts in the same "Label: value" style, and keep every other line exactly as it is, including anything the user wrote themselves. Return the whole updated text. Do not use any tools.`,
      `<event>${req.name}</event>`,
      `<details>\n${req.details}\n</details>`,
      `<answers>\n${qa}\n</answers>`,
    ].join('\n\n')
    const text = await run(cfg, prompt + withJsonSchema(z.object({ details: z.string() })), {}, 'default', { allowQuestions: false })
    return parseJson(z.object({ details: z.string() }), text)
  })
}

// ---------------------------------------------- writing rules (onboarding)

const RulesSchema = z.object({
  notes: z.array(z.string()).describe('5–8 short, imperative style notes, most important first.'),
})

export async function writingRules(cfg: OpencodeConfig, req: WritingRulesRequest): Promise<Result<{ notes: string[] }>> {
  return guard(async () => {
    const emails = req.emails.map((e, i) => `<email index="${i + 1}">\n${e.trim()}\n</email>`).join('\n')
    const prompt = [
      `These are emails one person wrote. Write a short style guide another writer could follow to sound like them in outreach emails: tone and formality, length and paragraph shape, how they open and sign off, sentence habits, words and phrases they use or avoid, spelling conventions (e.g. Australian or US). Only include what the emails actually show; ignore their specific content. Do not use any tools.`,
      emails,
    ].join('\n\n')
    const text = await run(cfg, prompt + withJsonSchema(RulesSchema), {}, 'default', { allowQuestions: false })
    return { notes: parseJson(RulesSchema, text).notes.slice(0, 10) }
  })
}

// ------------------------------------------------- adding organisations

const OrganisationsSchema = z.object({
  organisations: z.array(
    z.object({
      name: z.string().describe('The organisation’s name, as you’d search for it.'),
      website: z.string().describe('Its website if the user gave one (domain or URL), otherwise "".'),
      note: z.string().describe('Everything the user said that applies to this organisation, as a short instruction in their words. "" if nothing.'),
    }),
  ),
})

// Turns whatever the user typed ("Canva and Atlassian, both formal. PCBWay —
// mention Campfire…") into a list of organisations with their own notes.
export async function parseOrganisations(cfg: OpencodeConfig, text: string): Promise<Result<ParsedOrganisation[]>> {
  return guard(async () => {
    const prompt = [
      `The user is listing organisations they want to email, in their own words. List each organisation once, in the order given.

For each, keep any website they gave, and put everything they said about it in "note" as a short instruction in their words (e.g. "Mention they sponsored Campfire; ask for about 40 badges"). If something applies to several organisations ("both formal", "all of these are local"), add it to each one's note, reworded to stand alone ("Formal", not "Both formal"). Notes are instructions for writing or researching the email, so leave out the user's thinking aloud about whether to include one ("maybe", "not sure about this one"). A website alone isn't a note. Don't add anything they didn't say. Do not use any tools.`,
      `<text>\n${text}\n</text>`,
    ].join('\n\n')
    const out = parseJson(OrganisationsSchema, await run(cfg, prompt + withJsonSchema(OrganisationsSchema), {}, 'default', { allowQuestions: false }))
    return out.organisations.map((o) => ({ name: o.name.trim(), website: o.website.trim(), note: o.note.trim() })).filter((o) => o.name)
  })
}

// ------------------------------------------------------------- suggest leads

// Proposes organisations to reach out to, from the folder's event info and the
// campaign's notes. Web search confirms they exist and finds their website.
export async function suggestLeads(cfg: OpencodeConfig, req: LeadSuggestionsRequest, emit: Emit): Promise<Result<ParsedOrganisation[]>> {
  return guard(async () => {
    emit({ jobId: req.jobId, kind: 'step', text: 'Thinking of leads' })
    const count = req.count ?? 8
    const prompt = [
      `You suggest organisations for someone running an event to reach out to. Use what the event is (the event info) and what this campaign is asking for (the campaign notes) to propose real organisations that would be a good fit.

Search the web to confirm each organisation exists, find its website, and pick up anything specific worth mentioning (a past sponsorship, a relevant programme, a local tie). Prefer a mix of strong, plausible fits over a long list. Don't suggest anything already in "already_contacting".

For each, give the organisation's name (as you'd search for it), its website domain, and a "note": one short instruction on why it fits or what to mention when writing to them. If you can't confirm an organisation is real, leave it out. Don't invent websites.`,
      `<event_info>\n${req.eventInfo || '(none)'}\n</event_info>`,
      `<campaign_notes>\n${req.campaignNotes || '(none)'}\n</campaign_notes>`,
      req.emailFormat?.trim() ? `<email_format>\n${req.emailFormat.trim()}\n</email_format>` : '',
      req.existing?.length ? `<already_contacting>\n${req.existing.map((n) => `- ${n}`).join('\n')}\n</already_contacting>` : '',
      `Suggest up to ${count} organisations.`,
    ]
      .filter(Boolean)
      .join('\n\n')
    const text = await run(cfg, prompt + withJsonSchema(OrganisationsSchema), {
      onTool: (tool, input) => {
        const step = describeTool(tool, input)
        if (step) emit({ jobId: req.jobId, kind: 'step', text: step })
      },
      onFallback: (model) => emit({ jobId: req.jobId, kind: 'step', text: `Trying fallback model ${model}` }),
    }, 'research', { allowQuestions: true, context: 'Thinking of leads' })
    const out = parseJson(OrganisationsSchema, text)
    return out.organisations.map((o) => ({ name: o.name.trim(), website: o.website.trim(), note: o.note.trim() })).filter((o) => o.name).slice(0, count)
  })
}

// ------------------------------------------------------------- connection

export async function testOpencode(cfg: OpencodeConfig): Promise<Result<{ via: 'opencode' }>> {
  return guard(async () => {
    await run(cfg, 'Reply with just: OK', {}, 'default', { allowQuestions: false })
    return { via: 'opencode' as const }
  })
}

// ------------------------------------------------------------------ MCP auth

// opencode keeps MCP OAuth tokens in mcp-auth.json, keyed by server name. Inroad
// shares that store: signing in here also signs in the terminal. Sign-in runs
// `opencode mcp auth <name>` from the workspace, so it reads the project config
// Inroad writes.

// Runs an opencode subcommand (not `run`) and returns its combined output.
function runCli(cfg: OpencodeConfig, args: string[], timeoutMs = 5 * 60_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.executable, args, { cwd: cfg.workspace, env: { ...process.env, PWD: cfg.workspace } })
    let output = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('opencode timed out.'))
    }, timeoutMs)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => (output += chunk))
    child.stderr?.on('data', (chunk: string) => (output += chunk))
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(err.code === 'ENOENT' ? new Error(`Couldn’t find opencode at “${cfg.executable}”. Install opencode or set its path in Settings.`) : err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 0, output })
    })
  })
}

// Names (lowercased) opencode has a usable token for, from its store, falling
// back to its own listing when the store file is missing.
async function authedNames(cfg: OpencodeConfig): Promise<Set<string>> {
  const names = opencodeAuthenticatedServers()
  try {
    readFileSync(opencodeAuthFile(), 'utf8')
    return names
  } catch {
    // No store file: ask the CLI (its output has ANSI colour we strip).
  }
  try {
    const { code, output } = await runCli(cfg, ['mcp', 'auth', 'list'], 30_000)
    if (code !== 0) return names
    const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
    for (const s of mcpServers) {
      const name = s.name.trim()
      if (name && lines.some((l) => l.includes(name) && /authenticated/i.test(l))) names.add(name.toLowerCase())
    }
  } catch {
    // CLI unavailable: report nothing as authenticated.
  }
  return names
}

// The enabled remote servers and whether opencode already has a token for them.
export async function mcpAuthStatus(cfg: OpencodeConfig): Promise<McpAuthStatus[]> {
  const authed = await authedNames(cfg)
  return mcpServers
    .filter((s) => s.transport !== 'stdio' && !!s.url.trim())
    .map((s) => (authed.has(s.name.trim().toLowerCase()) ? { id: s.id, state: 'connected' as const } : { id: s.id, state: 'unknown' as const }))
}

// Signs in one remote server. opencode opens the browser itself; this waits for
// the flow to finish.
export async function authenticateMcp(cfg: OpencodeConfig, server: McpServer): Promise<Result<McpAuthStatus>> {
  return guard(async () => {
    if (server.transport === 'stdio') throw new Error('Local servers don’t use OAuth sign-in.')
    ensureProjectConfig(
      cfg.workspace,
      mcpServers.map((s) => (s.id === server.id ? { ...s, enabled: true } : s)),
    )
    const { code, output } = await runCli(cfg, ['mcp', 'auth', mcpServerKey(server)])
    if (code !== 0) throw new Error(tail(output) || `opencode exited with code ${code}.`)
    return { id: server.id, state: 'connected' as const }
  })
}

// Removes one remote server's stored token.
export async function logoutMcp(cfg: OpencodeConfig, server: McpServer): Promise<Result<McpAuthStatus>> {
  return guard(async () => {
    ensureProjectConfig(
      cfg.workspace,
      mcpServers.map((s) => (s.id === server.id ? { ...s, enabled: true } : s)),
    )
    const { code, output } = await runCli(cfg, ['mcp', 'logout', mcpServerKey(server)])
    if (code !== 0) throw new Error(tail(output) || `opencode exited with code ${code}.`)
    return { id: server.id, state: 'unknown' as const }
  })
}

const tail = (output: string): string => output.trim().split('\n').filter(Boolean).slice(-3).join(' ')
