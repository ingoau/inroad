import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { mcpServerKey } from '../shared/api'
import { claudeAuthenticatedServers, claudeNeedsAuthServers, claudeCredentialsFile, claudeNeedsAuthFile } from './mcp'
import type {
  ChatRequest,
  ChatResult,
  ClaudeProgress,
  DraftRequest,
  DraftResult,
  EventAnswersRequest,
  EventLookupRequest,
  EmailComment,
  EmailGuidance,
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

// Inroad drives Claude through the Claude Agent SDK (Claude Code as a library).
// With no API key set it uses this machine's Claude Code login; with a key it
// bills that key. 'opus' resolves to the newest Opus the account can use.
const MODEL = 'opus'

type Emit = (p: ClaudeProgress) => void

// Set once at startup (kept free of Electron imports so scripts can test this module).
// executable: set in packaged builds, where the SDK's bundled binary is unpacked
// next to the asar archive; otherwise the SDK finds it itself.
// openExternal: injected by the main process, used to open the browser during
// MCP OAuth sign-in (keeps Electron out of this module).
const config: { workspace: string; clientApp: string; executable?: string; openExternal?: (url: string) => void; mcpServers: McpServer[] } = {
  workspace: '',
  clientApp: 'inroad',
  mcpServers: [],
}
export function configureClaude(c: { workspace: string; clientApp: string; executable?: string; openExternal?: (url: string) => void }) {
  Object.assign(config, c)
  mkdirSync(c.workspace, { recursive: true })
}

// The MCP servers the user enabled in Settings, refreshed before each run.
export function setMcpServers(servers: McpServer[]) {
  config.mcpServers = servers
}

const toRecord = (pairs: { key: string; value: string }[]) =>
  Object.fromEntries(pairs.filter((p) => p.key.trim()).map((p) => [p.key.trim(), p.value]))

// The enabled servers as the SDK's mcpServers record, plus the allowedTools
// patterns (`mcp__<server>`) that let the agent call every tool they expose.
function mcpConfig() {
  const servers: NonNullable<Options['mcpServers']> = {}
  for (const s of config.mcpServers) {
    if (!s.enabled || !s.name.trim()) continue
    const key = mcpServerKey(s)
    if (s.transport === 'stdio') {
      if (!s.command.trim()) continue
      const env = toRecord(s.env)
      servers[key] = { type: 'stdio', command: s.command.trim(), args: s.args.filter((a) => a.trim()), ...(Object.keys(env).length ? { env } : {}) }
    } else {
      if (!s.url.trim()) continue
      const headers = toRecord(s.headers)
      servers[key] = { type: s.transport, url: s.url.trim(), ...(Object.keys(headers).length ? { headers } : {}) }
    }
  }
  const keys = Object.keys(servers)
  return { servers, keys, allow: keys.map((k) => `mcp__${k}`) }
}

// Each run gets an empty working folder and none of the user's own Claude Code
// settings, memory or skills, so it only ever has the tools listed here.
function baseOptions(apiKey: string | undefined, opts: Partial<Options>): Options {
  const cwd = config.workspace
  // User-added MCP servers load only for tasks that already allow tools; the
  // tool-less text jobs don't need them (and paying to start them is wasteful).
  const permitsTools = !!opts.allowedTools || !!opts.canUseTool
  const mcp = permitsTools ? mcpConfig() : { servers: {}, keys: [], allow: [] }
  const mcpServers = { ...mcp.servers, ...(opts.mcpServers ?? {}) }
  const allowedTools = opts.allowedTools ? [...opts.allowedTools, ...mcp.allow] : opts.allowedTools
  return {
    model: MODEL,
    cwd,
    ...(config.executable ? { pathToClaudeCodeExecutable: config.executable } : {}),
    settingSources: [],
    // The user's claude.ai connectors (Slack, email…) only load for the event
    // lookup, which asks for them; elsewhere they'd just add noise and startup time.
    settings: { disableClaudeAiConnectors: true },
    persistSession: false,
    // Anything not explicitly allowed is denied, never prompted for.
    permissionMode: 'dontAsk',
    env: {
      ...process.env,
      ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
      CLAUDE_AGENT_SDK_CLIENT_APP: config.clientApp,
    },
    ...opts,
    ...(Object.keys(mcpServers).length ? { mcpServers } : {}),
    ...(allowedTools ? { allowedTools } : {}),
  }
}

const AUTH_ERRORS: Record<string, string> = {
  authentication_failed: 'Claude isn’t signed in. Sign in to Claude Code on this computer, or add an API key in Settings.',
  oauth_org_not_allowed: 'Your Claude organisation doesn’t allow this. Add an API key in Settings instead.',
  billing_error: 'Claude reported a billing problem with this account.',
  rate_limit: 'You’ve hit Claude’s usage limit. Try again later.',
  model_not_found: 'Your Claude plan doesn’t include the model Inroad uses.',
}

// Runs one agent query to completion: forwards progress, returns the final
// result message, and turns SDK failures into messages a user can act on.
async function run(prompt: string, options: Options, onMessage?: (m: SDKMessage) => void) {
  let authError: string | undefined
  try {
    for await (const message of query({ prompt, options })) {
      onMessage?.(message)
      if (message.type === 'assistant' && message.error) authError ??= AUTH_ERRORS[message.error]
      if (message.type === 'result') {
        if (message.subtype !== 'success') throw new Error(authError ?? message.errors?.[0] ?? `Claude stopped early (${message.subtype}).`)
        return message
      }
    }
  } catch (err) {
    throw new Error(authError ?? (err instanceof Error ? err.message : String(err)))
  }
  throw new Error(authError ?? 'Claude ended without a result.')
}

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// Structured output: the SDK makes Claude return JSON matching the schema; we
// still validate it before trusting it.
function structured<S extends z.ZodType>(schema: S): Pick<Options, 'outputFormat'> {
  // Claude Code's validator rejects the draft-2020-12 "$schema" tag zod adds.
  const { $schema: _drop, ...json } = z.toJSONSchema(schema) as Record<string, unknown>
  return { outputFormat: { type: 'json_schema', schema: json } }
}
function parseOutput<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new Error('Claude’s answer didn’t come back in the expected format. Try again.')
  return parsed.data
}

function voiceSection(voice: VoiceInput) {
  const notes = voice.notes.length ? voice.notes.map((n) => `- ${n}`).join('\n') : '(no notes yet)'
  // Either Claude's draft and what the user sent instead, or an email they wrote themselves.
  const examples = voice.examples
    .map((e, i) =>
      e.draft
        ? `<example index="${i + 1}">\n<claude_draft>\n${e.draft}\n</claude_draft>\n<as_sent>\n${e.final}\n</as_sent>\n</example>`
        : `<example index="${i + 1}">\n<written_by_user>\n${e.final}\n</written_by_user>\n</example>`,
    )
    .join('\n')
  return `<voice name="${voice.name}">\n<style_notes>\n${notes}\n</style_notes>\n${examples ? `<examples>\n${examples}\n</examples>\n` : ''}</voice>`
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

// ------------------------------------------------- research + first draft

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

// The markdown dialect email bodies are stored in (see the renderer's markdown.ts).
const MARKDOWN = `Blank line between paragraphs; a single newline is a line break (e.g. between sign-off lines). **bold** and *italic* sparingly, [link text](https://url) for links, "- " or "1. " for lists, "> " for quotes. No headings, tables, images or HTML.`

const COMMENT_KINDS = `"verify" flags something the user should double-check before sending: a number, name, date or claim you couldn't confirm, or a guessed contact. "note" explains a choice, e.g. why you opened with a particular hook or why a detail is in there.`

const CommentSchema = z.object({
  quote: z
    .string()
    .describe(
      'Exact text from the email body, copied verbatim (including markdown), within a single paragraph. Keep it short: the phrase the comment is about.',
    ),
  comment: z.string().describe('One short sentence for the user.'),
  kind: z.enum(['verify', 'note']),
})

const EmailFields = {
  to: z.string().describe('Email of the single best recipient, or empty string if none has an address.'),
  subject: z.string(),
  body: z.string().describe(`The email body in markdown. ${MARKDOWN}`),
  comments: z
    .array(CommentSchema)
    .describe(`1–4 comments on specific phrases of the body, for the user reviewing it. ${COMMENT_KINDS} Flag anything uncertain; skip the obvious.`),
}

// Only keep comments whose quote really is in the body.
const anchored = (body: string, comments: EmailComment[]) => comments.filter((c) => c.quote.trim() && body.includes(c.quote))

const ResearchDraftSchema = z.object({
  research_notes: z
    .string()
    .describe('Everything useful you found, each fact with its source URL. Kept so the email can be rewritten later without searching again.'),
  brief: BriefSchema,
  ...EmailFields,
})

const WRITING_RULES = `Write the email exactly as the user writes: follow their style notes, and treat the examples (Claude's draft vs. what they actually sent) as the strongest signal of their preferences. Use only facts from your research; never invent details, numbers, people or email addresses. Open with something specific to this organisation, make one clear ask drawn from the campaign notes, and keep it short enough to read on a phone. Address the best recipient by first name when you have one. ${GUIDANCE_RULE}`

const RESEARCH_SYSTEM = `You research an organisation and write the user a personalised first-contact email to it. The user's campaign notes say what they're reaching out about and what to look for.

Research with WebSearch and WebFetch: what the organisation does; why they'd be a good fit for what the campaign asks for; recent, specific things that would open the email well; and the best people or inboxes to contact. Use any instructions the user gave for this organisation in your research too (for example, who to write to or what to look into). A handful of searches and a few page reads is usually enough. Only give an email address if it's published or very strongly evidenced, and say how you know.

${WRITING_RULES}`

export async function researchAndDraft(apiKey: string | undefined, req: ResearchRequest, emit: Emit): Promise<Result<ResearchResult>> {
  return guard(async () => {
    emit({ jobId: req.jobId, kind: 'step', text: `Researching ${req.company}` })
    const prompt = [
      `<campaign_notes>\n${req.campaignNotes || '(none)'}\n</campaign_notes>`,
      voiceSection(req.voice),
      `<sender>${req.senderName || 'the user'}</sender>`,
      ...guidanceSections(req),
      `Organisation: ${req.company}${req.website ? ` (website: ${req.website})` : ''}`,
    ].join('\n\n')
    const result = await run(
      prompt,
      baseOptions(apiKey, {
        systemPrompt: RESEARCH_SYSTEM,
        tools: ['WebSearch', 'WebFetch'],
        allowedTools: ['WebSearch', 'WebFetch'],
        effort: 'high',
        maxTurns: 30,
        ...structured(ResearchDraftSchema),
      }),
      // Each search / page read becomes a progress line in the UI.
      (m) => {
        if (m.type !== 'assistant') return
        for (const block of m.message.content) {
          if (block.type !== 'tool_use') continue
          const input = block.input as { query?: string; url?: string }
          if (block.name === 'WebSearch' && input.query) emit({ jobId: req.jobId, kind: 'step', text: `Searched “${input.query}”` })
          if (block.name === 'WebFetch' && input.url) emit({ jobId: req.jobId, kind: 'step', text: `Read ${input.url.replace(/^https?:\/\//, '')}` })
        }
      },
    )
    emit({ jobId: req.jobId, kind: 'step', text: 'Writing draft' })
    const out = parseOutput(ResearchDraftSchema, result.structured_output)
    return {
      research: out.research_notes,
      draft: { brief: out.brief, to: out.to, subject: out.subject, body: out.body, comments: anchored(out.body, out.comments) },
    }
  })
}

// ------------------------------------------- redraft from saved research

const DraftSchema = z.object({ brief: BriefSchema, ...EmailFields })

export async function draft(apiKey: string | undefined, req: DraftRequest): Promise<Result<DraftResult>> {
  return guard(async () => {
    const prompt = [
      `<campaign_notes>\n${req.campaignNotes || '(none)'}\n</campaign_notes>`,
      voiceSection(req.voice),
      `<sender>${req.senderName || 'the user'}</sender>`,
      `<organisation>${req.company}</organisation>`,
      ...guidanceSections(req),
      `<research_notes>\n${req.research}\n</research_notes>`,
      req.previousDraft
        ? `Write a fresh version that takes a noticeably different angle from this previous draft:\n<previous_draft>\n${req.previousDraft}\n</previous_draft>`
        : 'Write the brief and the email.',
    ].join('\n\n')
    const result = await run(
      prompt,
      baseOptions(apiKey, {
        systemPrompt: `You write first-contact outreach emails for the user, from research that's already been done. Also turn the research into a brief for the user to skim, and pick the best recipient.\n\n${WRITING_RULES}`,
        tools: [],
        effort: 'high',
        maxTurns: 4,
        ...structured(DraftSchema),
      }),
    )
    const out = parseOutput(DraftSchema, result.structured_output)
    return { ...out, comments: anchored(out.body, out.comments) }
  })
}

// -------------------------------------------------------------------- chat

const CHAT_SYSTEM = `You help the user refine one outreach email. You can see the email, the research brief, the campaign notes, any email format and instructions for this organisation, and the user's voice. Keep the email within the format and instructions unless the user asks otherwise.

The email body is markdown, exactly as stored: ${MARKDOWN} Links and formatting are part of the text you see and can change.

To change the email, call the propose_edit tool: quote the exact text to replace (copied verbatim from the subject or body, long enough to be unique, within a single paragraph) and give the replacement. To delete something, quote it with a few surrounding words and leave those words in the replacement. Each call becomes a suggestion the user can accept or reject, so prefer a few focused edits over rewriting everything, and stay in the user's voice. When the user asks what you think, wants something checked, or asks why something is there, call add_comment to pin your answer to the phrase it's about rather than only describing it in your reply. Don't repeat comments the email already has. Use WebSearch only if the user asks for something the brief doesn't cover. Keep your messages short.`

export async function chat(apiKey: string | undefined, req: ChatRequest, emit: Emit): Promise<Result<ChatResult>> {
  return guard(async () => {
    const proposals: ProposedEdit[] = []
    // The tool doesn't edit anything itself: it records a suggestion for the
    // user to accept or reject, after checking the quoted text really exists.
    const proposeEdit = tool(
      'propose_edit',
      'Suggest replacing a passage of the email. The user sees it as an accept/reject card.',
      {
        old: z
          .string()
          .min(1)
          .describe('Exact text currently in the subject or body, copied verbatim, including any markdown such as [text](url) or **bold**.'),
        new: z.string().min(1).describe('Replacement text, in the same markdown.'),
        reason: z.string().describe('A few words on why, shown to the user.'),
      },
      async (edit) => {
        if (!req.body.includes(edit.old) && !req.subject.includes(edit.old))
          return { content: [{ type: 'text', text: 'That text isn’t in the email. Quote it exactly as it appears.' }], isError: true }
        proposals.push(edit)
        return { content: [{ type: 'text', text: 'Shown to the user as a suggestion.' }] }
      },
      { annotations: { readOnlyHint: true }, alwaysLoad: true },
    )
    const comments: EmailComment[] = []
    // Like propose_edit, but only remarks on a passage without changing it.
    const addComment = tool(
      'add_comment',
      `Pin a short comment to a phrase in the email body, shown next to it for the user. ${COMMENT_KINDS}`,
      {
        quote: CommentSchema.shape.quote,
        comment: CommentSchema.shape.comment,
        kind: CommentSchema.shape.kind,
      },
      async (c) => {
        if (!req.body.includes(c.quote))
          return { content: [{ type: 'text', text: 'That text isn’t in the email body. Quote it exactly as it appears.' }], isError: true }
        comments.push(c)
        return { content: [{ type: 'text', text: 'Pinned to the email for the user.' }] }
      },
      { annotations: { readOnlyHint: true }, alwaysLoad: true },
    )
    const editor = createSdkMcpServer({ name: 'email', version: '1.0.0', tools: [proposeEdit, addComment] })

    const context = [
      `<campaign_notes>\n${req.campaignNotes || '(none)'}\n</campaign_notes>`,
      voiceSection(req.voice),
      ...guidanceSections(req),
      req.comments?.length
        ? `<comments_on_email>\n${req.comments.map((c) => `- [${c.kind}] "${c.quote}": ${c.comment}`).join('\n')}\n</comments_on_email>`
        : '',
      req.brief ? `<brief organisation="${req.company}">\n${JSON.stringify(req.brief)}\n</brief>` : '',
      `<email>\nSubject: ${req.subject}\n\n${req.body}\n</email>`,
    ]
      .filter(Boolean)
      .join('\n\n')
    // Earlier turns are replayed as a transcript: the user has already acted on
    // those suggestions, and the email above is the current version.
    const transcript = req.history.length
      ? `<conversation_so_far>\n${req.history.map((m) => `${m.role === 'user' ? 'User' : 'You'}: ${m.text}`).join('\n\n')}\n</conversation_so_far>\n\n`
      : ''

    let text = ''
    const result = await run(
      `${context}\n\n${transcript}User: ${req.message}`,
      baseOptions(apiKey, {
        systemPrompt: CHAT_SYSTEM,
        tools: ['WebSearch'],
        mcpServers: { email: editor },
        allowedTools: ['WebSearch', 'mcp__email__propose_edit', 'mcp__email__add_comment'],
        effort: 'medium',
        maxTurns: 12,
        includePartialMessages: true,
      }),
      (m) => {
        // Stream Claude's reply text into the chat as it's written. Text
        // either side of a tool call arrives as separate blocks.
        if (m.type !== 'stream_event') return
        const e = m.event
        const chunk =
          e.type === 'content_block_start' && e.content_block.type === 'text' && text
            ? '\n\n'
            : e.type === 'content_block_delta' && e.delta.type === 'text_delta'
              ? e.delta.text
              : ''
        if (!chunk) return
        text += chunk
        emit({ jobId: req.jobId, kind: 'delta', text: chunk })
      },
    )
    return { text: text.trim() || result.result.trim(), proposals, comments }
  })
}

// ------------------------------------------------------------ voice learning

const VoiceSchema = z.object({
  add: z.array(z.string()).describe('New style notes: short, imperative, general. At most 3.'),
  remove: z.array(z.string()).describe('Existing notes that the edits clearly contradict, quoted exactly.'),
})

export async function learnVoice(apiKey: string | undefined, req: VoiceLearnRequest): Promise<Result<VoiceLearnResult>> {
  return guard(async () => {
    const result = await run(
      `<existing_notes voice="${req.voiceName}">\n${req.notes.map((n) => `- ${n}`).join('\n') || '(none)'}\n</existing_notes>\n\n<claude_draft>\n${req.draft}\n</claude_draft>\n\n<as_saved>\n${req.final}\n</as_saved>`,
      baseOptions(apiKey, {
        systemPrompt: `You maintain a short style guide describing how one person writes outreach emails. You're given Claude's draft and the version they actually saved.\n\nExtract only general, reusable preferences: tone, length, structure, openers and sign-offs, words or phrases they add or avoid. Ignore edits about this particular organisation's facts. Don't repeat anything the existing notes already say. If nothing general changed, return empty lists.`,
        tools: [],
        effort: 'low',
        maxTurns: 4,
        ...structured(VoiceSchema),
      }),
    )
    const out = parseOutput(VoiceSchema, result.structured_output)
    // Only remove notes that really exist.
    return { add: out.add.slice(0, 3), remove: out.remove.filter((r) => req.notes.includes(r)) }
  })
}

// ------------------------------------------------------- event lookup

// Connector tools (Slack, email…) come from the user's Claude account and
// can do anything, so only ones that look read-only by name are allowed.
const READ_WORDS = /^(search|read|get|list|fetch|find|query|view|lookup|retrieve|describe|show|open)$/
const WRITE_WORDS =
  /^(send|post|create|delete|update|write|reply|archive|upload|schedule|add|remove|set|draft|move|complete|uncomplete|rsvp|react|edit|invite|share|publish|forward|mark|manage|import|export|restart|call|run|bulk)$/
export function isReadOnlyTool(name: string) {
  const words = name.toLowerCase().split(/[_\-\s]+/)
  return words.some((w) => READ_WORDS.test(w)) && !words.some((w) => WRITE_WORDS.test(w))
}

// "mcp__claude_ai_Slack__slack_search_public" → "Slack"
const connectorName = (tool: string) =>
  tool
    .split('__')[1]
    ?.replace(/^claude_ai_/, '')
    .replace(/_/g, ' ') ?? tool

const EventSchema = z.object({
  facts: z
    .array(z.object({ label: z.string().describe('Short label, e.g. "What it is", "Dates", "Place", "Who comes", "What we ask for".'), value: z.string() }))
    .describe(
      'What a partner reading an outreach email should know about the event, most important first. Only facts you found; leave out anything unknown or unsettled.',
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

const EVENT_EXCLUDE = `Only include facts about the event itself that would help write outreach emails. Leave out:
- sources, citations, links to Slack channels or internal docs, and where you found anything
- outreach already sent or drafted, sponsors or partners already confirmed, and venues already approached or ruled out
- other people working on the event, and anyone's contact details
- internal logistics and discussion (insurance, budget, hire agreements, to-dos)
- notes about tools, connectors or access
Public links (the event's website or social pages) are fine. Never write "unknown": leave it out, or ask about it if it matters.`

const asDetails = (facts: { label: string; value: string }[]) =>
  facts
    .filter((f) => f.label.trim() && f.value.trim())
    .map((f) => `${f.label.trim()}: ${f.value.trim()}`)
    .join('\n')

export async function lookupEvent(apiKey: string | undefined, req: EventLookupRequest, emit: Emit): Promise<Result<EventLookupResult>> {
  return guard(async () => {
    emit({ jobId: req.jobId, kind: 'step', text: `Looking for “${req.name}”` })
    // Servers the user added themselves are trusted in full; the read-only
    // filter below only guards the account's claude.ai connectors.
    const userMcp = mcpConfig().keys
    const result = await run(
      `Event: ${req.name}${req.hint ? `\nWhat the user added: ${req.hint}` : ''}`,
      baseOptions(apiKey, {
        systemPrompt: `The user organises the event named below and is setting up an app that writes outreach emails (sponsors, venues, partners) for it. Find what's known about the event so they don't have to type it out.

Look in their connected tools first: search their Slack, email, docs, notes or task manager for the event name and read the most relevant threads or documents. Then check the web for a public page. Only use tools to read and search; never send, post, create or change anything. Stop once you have a clear picture; a dozen or so tool calls is plenty.

Only report what you found. If sources disagree on something that matters, don't explain it in the facts: ask the user instead. If you find nothing, return no facts and ask what the event is.

${EVENT_EXCLUDE}`,
        tools: ['WebSearch', 'WebFetch', 'ToolSearch'],
        // Every tool call comes to canUseTool: the built-ins above, plus
        // connector tools only if they look read-only.
        permissionMode: 'default',
        settings: { disableClaudeAiConnectors: false },
        canUseTool: async (toolName, input) =>
          ['WebSearch', 'WebFetch', 'ToolSearch'].includes(toolName) ||
          userMcp.some((k) => toolName.startsWith(`mcp__${k}__`)) ||
          (toolName.startsWith('mcp__') && isReadOnlyTool(toolName.split('__').at(-1) ?? ''))
            ? { behavior: 'allow', updatedInput: input }
            : { behavior: 'deny', message: 'Inroad only lets you read and search here, not change anything.' },
        effort: 'medium',
        maxTurns: 30,
        ...structured(EventSchema),
      }),
      (m) => {
        if (m.type !== 'assistant') return
        for (const block of m.message.content) {
          if (block.type !== 'tool_use') continue
          const input = block.input as { query?: string; url?: string }
          if (block.name === 'WebSearch' && input.query) emit({ jobId: req.jobId, kind: 'step', text: `Searched the web for “${input.query}”` })
          else if (block.name === 'WebFetch' && input.url) emit({ jobId: req.jobId, kind: 'step', text: `Read ${input.url.replace(/^https?:\/\//, '')}` })
          else if (block.name.startsWith('mcp__')) emit({ jobId: req.jobId, kind: 'step', text: `Checked ${connectorName(block.name)}` })
        }
      },
    )
    const out = parseOutput(EventSchema, result.structured_output)
    return { details: asDetails(out.facts), questions: out.questions.filter((q) => q.question.trim()).slice(0, 4) }
  })
}

// Folds the user's answers into the event details, leaving the rest alone.
export async function applyEventAnswers(apiKey: string | undefined, req: EventAnswersRequest): Promise<Result<{ details: string }>> {
  return guard(async () => {
    const qa = req.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n')
    const result = await run(
      `<event>${req.name}</event>\n\n<details>\n${req.details}\n</details>\n\n<answers>\n${qa}\n</answers>`,
      baseOptions(apiKey, {
        systemPrompt: `Update the event details with the user's answers to your questions. Change only what the answers affect: add or correct those facts in the same "Label: value" style, and keep every other line exactly as it is, including anything the user wrote themselves. Return the whole updated text.`,
        tools: [],
        effort: 'low',
        maxTurns: 3,
        ...structured(z.object({ details: z.string() })),
      }),
    )
    return parseOutput(z.object({ details: z.string() }), result.structured_output)
  })
}

// ----------------------------------------------- writing rules (onboarding)

const RulesSchema = z.object({
  notes: z.array(z.string()).describe('5–8 short, imperative style notes, most important first.'),
})

export async function writingRules(apiKey: string | undefined, req: WritingRulesRequest): Promise<Result<{ notes: string[] }>> {
  return guard(async () => {
    const emails = req.emails.map((e, i) => `<email index="${i + 1}">\n${e.trim()}\n</email>`).join('\n')
    const result = await run(
      emails,
      baseOptions(apiKey, {
        systemPrompt: `These are emails one person wrote. Write a short style guide another writer could follow to sound like them in outreach emails: tone and formality, length and paragraph shape, how they open and sign off, sentence habits, words and phrases they use or avoid, spelling conventions (e.g. Australian or US). Only include what the emails actually show; ignore their specific content.`,
        tools: [],
        effort: 'medium',
        maxTurns: 4,
        ...structured(RulesSchema),
      }),
    )
    return { notes: parseOutput(RulesSchema, result.structured_output).notes.slice(0, 10) }
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
export async function parseOrganisations(apiKey: string | undefined, text: string): Promise<Result<ParsedOrganisation[]>> {
  return guard(async () => {
    const result = await run(
      `<text>\n${text}\n</text>`,
      baseOptions(apiKey, {
        // A quick extraction job; a smaller model is plenty.
        model: 'haiku',
        systemPrompt: `The user is listing organisations they want to email, in their own words. List each organisation once, in the order given.

For each, keep any website they gave, and put everything they said about it in "note" as a short instruction in their words (e.g. "Mention they sponsored Campfire; ask for about 40 badges"). If something applies to several organisations ("both formal", "all of these are local"), add it to each one's note, reworded to stand alone ("Formal", not "Both formal"). Notes are instructions for writing or researching the email, so leave out the user's thinking aloud about whether to include one ("maybe", "not sure about this one"). A website alone isn't a note. Don't add anything they didn't say.`,
        tools: [],
        maxTurns: 3,
        ...structured(OrganisationsSchema),
      }),
    )
    return parseOutput(OrganisationsSchema, result.structured_output)
      .organisations.map((o) => ({ name: o.name.trim(), website: o.website.trim(), note: o.note.trim() }))
      .filter((o) => o.name)
  })
}

// ------------------------------------------------------------- suggest leads

// Proposes organisations to reach out to, from the folder's event info and the
// campaign's notes. Web search confirms they exist and finds their website.
export async function suggestLeads(apiKey: string | undefined, req: LeadSuggestionsRequest, emit: Emit): Promise<Result<ParsedOrganisation[]>> {
  return guard(async () => {
    emit({ jobId: req.jobId, kind: 'step', text: 'Thinking of leads' })
    const count = req.count ?? 8
    const prompt = [
      `<event_info>\n${req.eventInfo || '(none)'}\n</event_info>`,
      `<campaign_notes>\n${req.campaignNotes || '(none)'}\n</campaign_notes>`,
      req.emailFormat?.trim() ? `<email_format>\n${req.emailFormat.trim()}\n</email_format>` : '',
      req.existing?.length ? `<already_contacting>\n${req.existing.map((n) => `- ${n}`).join('\n')}\n</already_contacting>` : '',
      `Suggest up to ${count} organisations.`,
    ]
      .filter(Boolean)
      .join('\n\n')
    const result = await run(
      prompt,
      baseOptions(apiKey, {
        systemPrompt: `You suggest organisations for someone running an event to reach out to. Use what the event is (the event info) and what this campaign is asking for (the campaign notes) to propose real organisations that would be a good fit.

Search the web to confirm each organisation exists, find its website, and pick up anything specific worth mentioning (a past sponsorship, a relevant programme, a local tie). Prefer a mix of strong, plausible fits over a long list. Don't suggest anything already in "already_contacting".

For each, give the organisation's name (as you'd search for it), its website domain, and a "note": one short instruction on why it fits or what to mention when writing to them. If you can't confirm an organisation is real, leave it out. Don't invent websites.`,
        tools: ['WebSearch', 'WebFetch'],
        allowedTools: ['WebSearch', 'WebFetch'],
        effort: 'medium',
        maxTurns: 30,
        ...structured(OrganisationsSchema),
      }),
      // Each search / page read becomes a progress line in the UI.
      (m) => {
        if (m.type !== 'assistant') return
        for (const block of m.message.content) {
          if (block.type !== 'tool_use') continue
          const input = block.input as { query?: string; url?: string }
          if (block.name === 'WebSearch' && input.query) emit({ jobId: req.jobId, kind: 'step', text: `Searched “${input.query}”` })
          if (block.name === 'WebFetch' && input.url) emit({ jobId: req.jobId, kind: 'step', text: `Read ${input.url.replace(/^https?:\/\//, '')}` })
        }
      },
    )
    return parseOutput(OrganisationsSchema, result.structured_output)
      .organisations.map((o) => ({ name: o.name.trim(), website: o.website.trim(), note: o.note.trim() }))
      .filter((o) => o.name)
      .slice(0, count)
  })
}

// ------------------------------------------------------------- connection

// A tiny request to check Claude is reachable with the current sign-in or key.
export async function testClaude(apiKey: string | undefined): Promise<Result<{ via: 'api-key' | 'claude-login' }>> {
  return guard(async () => {
    await run('Reply with just: OK', baseOptions(apiKey, { tools: [], effort: 'low', maxTurns: 1 }))
    return { via: apiKey ? ('api-key' as const) : ('claude-login' as const) }
  })
}

// ------------------------------------------------------------------ MCP auth

// Claude Code stores MCP OAuth tokens in ~/.claude/.credentials.json. Inroad
// shares that store, so a sign-in here also signs in the terminal (and vice
// versa). Sign-in drives the SDK's URL elicitation: open the browser, accept,
// then reconnect until the server reports connected.

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const AUTH_TIMEOUT_MS = 5 * 60_000

// One entry in the SDK's mcpServers record (derived, so we don't reach for an
// unexported type).
type CliMcpServer = NonNullable<Options['mcpServers']>[string]

// The SDK config for one remote server. alwaysLoad makes startup wait for the
// connection, so an unauthenticated server elicits during init, not mid-run.
function remoteServerConfig(s: McpServer, alwaysLoad: boolean): CliMcpServer {
  const headers = toRecord(s.headers)
  return {
    type: s.transport,
    url: s.url.trim(),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(alwaysLoad ? { alwaysLoad: true } : {}),
  } as CliMcpServer
}

// The user-enabled remote servers and their stored sign-in state.
export function mcpAuthStatus(): McpAuthStatus[] {
  const authed = claudeAuthenticatedServers()
  const needs = claudeNeedsAuthServers()
  return config.mcpServers
    .filter((s) => s.transport !== 'stdio' && !!s.url.trim())
    .map((s) => {
      const name = s.name.trim().toLowerCase()
      if (authed.has(name)) return { id: s.id, state: 'connected' as const }
      if (needs.has(name)) return { id: s.id, state: 'needs-auth' as const }
      return { id: s.id, state: 'unknown' as const }
    })
}

// Reads one server's live status from a running query; 'pending'/'disabled'
// read as unknown so the UI keeps waiting rather than calling them done.
async function liveStatus(q: ReturnType<typeof query>, key: string, id: string): Promise<McpAuthStatus> {
  try {
    const status = (await q.mcpServerStatus()).find((s) => s.name === key)
    if (!status) return { id, state: 'unknown' }
    if (status.status === 'connected') return { id, state: 'connected' }
    if (status.status === 'needs-auth') return { id, state: 'needs-auth' }
    if (status.status === 'failed') return { id, state: 'failed', detail: status.error }
    return { id, state: 'unknown' }
  } catch (err) {
    return { id, state: 'unknown', detail: err instanceof Error ? err.message : String(err) }
  }
}

// Signs in one remote server, opening the browser when the server asks. Uses a
// throwaway query holding only this server, then closes it.
export async function authenticateMcp(apiKey: string | undefined, server: McpServer): Promise<Result<McpAuthStatus>> {
  return guard(async () => {
    if (server.transport === 'stdio') throw new Error('Local servers don’t use OAuth sign-in.')
    const key = mcpServerKey(server)
    const mcpServers: Record<string, CliMcpServer> = { [key]: remoteServerConfig(server, true) }

    // Streaming input keeps the session (and its connection attempts) alive
    // until we release it, so the browser flow isn't cut short.
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    async function* input(): AsyncIterable<SDKUserMessage> {
      yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'Connect to the MCP server, then reply OK.' } }
      await held
    }

    const q = query({
      prompt: input(),
      options: baseOptions(apiKey, {
        mcpServers,
        tools: [],
        effort: 'low',
        maxTurns: 1,
        onElicitation: async (req) => {
          if (req.mode === 'url' && req.url && config.openExternal) {
            config.openExternal(req.url)
            return { action: 'accept' }
          }
          return { action: 'decline' }
        },
      }),
    })

    // Drive the session in the background while we poll for the connection.
    const consumed = (async () => {
      try {
        for await (const message of q) {
          if (message.type === 'system' && message.subtype === 'elicitation_complete') break
        }
      } catch {
        // The session ending is fine; the polling below decides the outcome.
      }
    })()

    try {
      let status = await liveStatus(q, key, server.id)
      const deadline = Date.now() + AUTH_TIMEOUT_MS
      while (status.state !== 'connected' && Date.now() < deadline) {
        if (status.state === 'failed') break
        // Nudge a server the CLI has flagged; a fresh connect can re-elicit.
        try {
          await q.reconnectMcpServer(key)
        } catch {
          // Not connected yet; the next poll will tell us more.
        }
        await sleep(2000)
        status = await liveStatus(q, key, server.id)
      }
      if (status.state !== 'connected') {
        return status.state === 'failed'
          ? status
          : { id: server.id, state: 'needs-auth' as const, detail: 'Sign-in wasn’t completed in the browser.' }
      }
      return status
    } finally {
      release()
      q.close()
      await consumed.catch(() => {})
    }
  })
}

// Removes this server's stored OAuth token (and its needs-auth flag), falling
// back to the CLI when there's no token file to edit.
export async function logoutMcp(server: McpServer): Promise<Result<McpAuthStatus>> {
  return guard(async () => {
    const name = server.name.trim()
    const nameLc = name.toLowerCase()
    let edited = false
    try {
      const creds = JSON.parse(readFileSync(claudeCredentialsFile(), 'utf8'))
      if (isObject(creds) && isObject(creds.mcpOAuth)) {
        for (const [k, entry] of Object.entries(creds.mcpOAuth)) {
          const entryName = isObject(entry) ? String(entry.serverName ?? '').toLowerCase() : ''
          if (entryName === nameLc || k.toLowerCase().startsWith(`${nameLc}|`)) {
            delete creds.mcpOAuth[k]
            edited = true
          }
        }
        if (edited) writeFileSync(claudeCredentialsFile(), JSON.stringify(creds, null, 2), { mode: 0o600 })
      }
    } catch {
      // No credentials file, or unreadable: try the CLI below.
    }
    try {
      const cache = JSON.parse(readFileSync(claudeNeedsAuthFile(), 'utf8'))
      if (isObject(cache)) {
        const hit = Object.keys(cache).find((k) => k.toLowerCase() === nameLc)
        if (hit) {
          delete cache[hit]
          writeFileSync(claudeNeedsAuthFile(), JSON.stringify(cache))
        }
      }
    } catch {
      // No needs-auth cache: nothing to clear.
    }
    if (!edited) await claudeMcpLogoutCli(name)
    return { id: server.id, state: 'unknown' as const }
  })
}

// Runs the bundled `claude mcp logout <name>` when we couldn't edit the store.
function claudeMcpLogoutCli(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(config.executable || 'claude', ['mcp', 'logout', name], { cwd: config.workspace, env: process.env })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `claude mcp logout exited with code ${code}.`))))
  })
}
