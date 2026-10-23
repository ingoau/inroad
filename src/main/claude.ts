import { createSdkMcpServer, query, tool, type Options, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync } from 'node:fs'
import { z } from 'zod'
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
import type { ChatFileData } from '../shared/chatFiles'

// Inroad drives Claude through the Claude Agent SDK (Claude Code as a library).
// With no API key set it uses this machine's Claude Code login; with a key it
// bills that key. Models come from Settings → AI agent: `model` for research,
// drafting and chat, `utilityModel` for quick processing jobs.
export interface ClaudeConfig {
  apiKey?: string
  model: string
  utilityModel: string
}

type Emit = (p: ClaudeProgress) => void

// What a stopped request reports (see run).
const STOPPED = 'Stopped.'

// Set once at startup (kept free of Electron imports so scripts can test this module).
// executable: set in packaged builds, where the SDK's bundled binary is unpacked
// next to the asar archive; otherwise the SDK finds it itself.
const config: { workspace: string; clientApp: string; executable?: string } = { workspace: '', clientApp: 'inroad' }
export function configureClaude(c: typeof config) {
  Object.assign(config, c)
  mkdirSync(c.workspace, { recursive: true })
}

// Each run gets an empty working folder and none of the user's own Claude Code
// settings, memory or skills, so it only ever has the tools listed here.
function baseOptions(cfg: ClaudeConfig, opts: Partial<Options>): Options {
  const cwd = config.workspace
  const apiKey = cfg.apiKey
  return {
    model: cfg.model,
    cwd,
    ...(config.executable ? { pathToClaudeCodeExecutable: config.executable } : {}),
    settingSources: [],
    // The user's claude.ai connectors (Slack, email…) only load for the event
    // lookup and chat, which ask for them (see readOnlyConnectors); elsewhere
    // they'd just add noise and startup time.
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
  }
}

const AUTH_ERRORS: Record<string, string> = {
  authentication_failed: 'Claude isn’t signed in. Sign in to Claude Code on this computer, or add an API key in Settings.',
  oauth_org_not_allowed: 'Your Claude organisation doesn’t allow this. Add an API key in Settings instead.',
  billing_error: 'Claude reported a billing problem with this account.',
  rate_limit: 'You’ve hit Claude’s usage limit. Try again later.',
  model_not_found: 'Your Claude plan doesn’t include the model chosen in Settings → AI agent.',
}

// Runs one agent query to completion: forwards progress, returns the final
// result message, and turns SDK failures into messages a user can act on.
// Aborting options.abortController stops it with STOPPED. A prompt of content
// blocks (text with images or documents) is sent as one streamed user message.
type Content = Exclude<SDKUserMessage['message']['content'], string>
async function run(prompt: string | Content, options: Options, onMessage?: (m: SDKMessage) => void) {
  let authError: string | undefined
  const stopped = () => options.abortController?.signal.aborted
  const input =
    typeof prompt === 'string'
      ? prompt
      : (async function* (): AsyncGenerator<SDKUserMessage> {
          yield { type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null }
        })()
  try {
    for await (const message of query({ prompt: input, options })) {
      onMessage?.(message)
      if (message.type === 'assistant' && message.error) authError ??= AUTH_ERRORS[message.error]
      if (message.type === 'result') {
        if (message.subtype !== 'success') throw new Error(authError ?? message.errors?.[0] ?? `Claude stopped early (${message.subtype}).`)
        return message
      }
    }
  } catch (err) {
    if (stopped()) throw new Error(STOPPED)
    throw new Error(authError ?? (err instanceof Error ? err.message : String(err)))
  }
  if (stopped()) throw new Error(STOPPED)
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

const ResearchOnlySchema = z.object({
  research_notes: z
    .string()
    .describe('Everything useful you found, each fact with its source URL. Kept so the email can be written later without searching again.'),
  brief: BriefSchema,
})

const ResearchDraftSchema = ResearchOnlySchema.extend(EmailFields)

const WRITING_RULES = `Write the email exactly as the user writes: follow their style notes, and treat the examples (Claude's draft vs. what they actually sent) as the strongest signal of their preferences. Use only facts from your research; never invent details, numbers, people or email addresses. Open with something specific to this organisation, make one clear ask drawn from the campaign notes, and keep it short enough to read on a phone. Address the best recipient by first name when you have one. ${GUIDANCE_RULE}`

const RESEARCH_STEPS = `Research with WebSearch and WebFetch: what the organisation does; why they'd be a good fit for what the campaign asks for; recent, specific things that would open an email well; and the best people or inboxes to contact. Use any instructions the user gave for this organisation in your research too (for example, who to write to or what to look into). A handful of searches and a few page reads is usually enough. Only give an email address if it's published or very strongly evidenced, and say how you know.`

const RESEARCH_SYSTEM = `You research an organisation and write the user a personalised first-contact email to it. The user's campaign notes say what they're reaching out about and what to look for.

${RESEARCH_STEPS}

${WRITING_RULES}`

// The user turned drafting off: research and the brief, but no email yet.
const RESEARCH_ONLY_SYSTEM = `You research an organisation for the user, who may write to it later. The user's campaign notes say what they're reaching out about and what to look for. Don't write an email: turn what you find into research notes and a brief for the user to skim.

${RESEARCH_STEPS}`

export async function researchAndDraft(cfg: ClaudeConfig, req: ResearchRequest, emit: Emit, abort?: AbortController): Promise<Result<ResearchResult>> {
  return guard(async () => {
    const withDraft = req.draft !== false
    const schema = withDraft ? ResearchDraftSchema : ResearchOnlySchema
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
      baseOptions(cfg, {
        systemPrompt: withDraft ? RESEARCH_SYSTEM : RESEARCH_ONLY_SYSTEM,
        tools: ['WebSearch', 'WebFetch'],
        allowedTools: ['WebSearch', 'WebFetch'],
        effort: 'high',
        maxTurns: 30,
        abortController: abort,
        ...structured(schema),
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
    if (!withDraft) {
      const out = parseOutput(ResearchOnlySchema, result.structured_output)
      return { research: out.research_notes, brief: out.brief }
    }
    emit({ jobId: req.jobId, kind: 'step', text: 'Writing draft' })
    const out = parseOutput(ResearchDraftSchema, result.structured_output)
    return {
      research: out.research_notes,
      brief: out.brief,
      draft: { to: out.to, subject: out.subject, body: out.body, comments: anchored(out.body, out.comments) },
    }
  })
}

// ------------------------------------------- redraft from saved research

const DraftSchema = z.object({ brief: BriefSchema, ...EmailFields })

export async function draft(cfg: ClaudeConfig, req: DraftRequest): Promise<Result<DraftResult>> {
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
      baseOptions(cfg, {
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

// ------------------------------------------------------ connected tools

// Connector tools (Slack, email…) come from the user's Claude account and
// can do anything, so only ones that look read-only by name are allowed.
const READ_WORDS = /^(search|read|get|list|fetch|find|query|view|lookup|retrieve|describe|show|open)$/
const WRITE_WORDS =
  /^(send|post|create|delete|update|write|reply|archive|upload|schedule|add|remove|set|draft|move|complete|uncomplete|rsvp|react|edit|invite|share|publish|forward|mark|manage|import|export|restart|call|run|bulk|replace|insert|append|execute|exec|merge|approve|submit|trash|sql|mutate|mutation|patch|put|assign|cancel|close|transfer|pay|invoke|trigger|apply|rename|duplicate|copy|restore|purge|clear|reset|join|leave|accept|decline)$/
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

// Loads the user's claude.ai connectors and sends every tool call through
// canUseTool: the web tools and `allowed` (Inroad's own tools) go through,
// connector tools only if they look read-only.
function readOnlyConnectors(allowed: string[] = []): Partial<Options> {
  const builtIn = ['WebSearch', 'WebFetch', 'ToolSearch']
  return {
    tools: builtIn,
    permissionMode: 'default',
    settings: { disableClaudeAiConnectors: false },
    canUseTool: async (toolName, input) =>
      builtIn.includes(toolName) || allowed.includes(toolName) || (toolName.startsWith('mcp__') && isReadOnlyTool(toolName.split('__').at(-1) ?? ''))
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Inroad only lets you read and search here, not change anything.' },
  }
}

// A progress line for a web or connector tool call, if it's worth showing.
function toolStep(m: SDKMessage): string[] {
  if (m.type !== 'assistant') return []
  const steps: string[] = []
  for (const block of m.message.content) {
    if (block.type !== 'tool_use') continue
    const input = block.input as { query?: string; url?: string }
    if (block.name === 'WebSearch' && input.query) steps.push(`Searched the web for “${input.query}”`)
    else if (block.name === 'WebFetch' && input.url) steps.push(`Read ${input.url.replace(/^https?:\/\//, '')}`)
    else if (block.name.startsWith('mcp__') && !block.name.startsWith('mcp__email__')) steps.push(`Checked ${connectorName(block.name)}`)
  }
  return steps
}

// -------------------------------------------------------------------- chat

const CHAT_SYSTEM = `You help the user refine one outreach email. You can see the email, the research brief, the campaign notes, any email format and instructions for this organisation, and the user's voice. Keep the email within the format and instructions unless the user asks otherwise.

The email body is markdown, exactly as stored: ${MARKDOWN} Links and formatting are part of the text you see and can change.

The user may point at a passage they highlighted in the email; it's quoted with their message. Read it as "this part", and keep any edits to it unless they ask for more.

The user can attach files to their messages: images (screenshots, photos, flyers), PDFs and text files. Each comes before everything else, labelled with its file name, and the messages that attached them say so. Use them as the user intends, e.g. a screenshot of an email thread to reply to, a prospectus to draw facts from, or a photo to describe.

To change the email, call the propose_edit tool: quote the exact text to replace (copied verbatim from the subject or body, long enough to be unique, within a single paragraph) and give the replacement. To delete something, quote it with a few surrounding words and leave those words in the replacement. Each call becomes a suggestion the user can accept or reject, so prefer a few focused edits over rewriting everything, and stay in the user's voice. When the user asks what you think, wants something checked, or asks why something is there, call add_comment to pin your answer to the phrase it's about rather than only describing it in your reply. Don't repeat comments the email already has. If the user asks for something the brief doesn't cover, look it up: WebSearch and WebFetch for the web, and their connected tools (Slack, email, docs, notes…) for anything about their own work or contacts. Only read and search with those tools; never send, post, create or change anything. Keep your messages short.`

// The chat's attached files as content blocks, each introduced by its name so
// Claude can tell them apart and match them to the transcript.
function fileBlocks(files: ChatFileData[]): Content {
  return files.flatMap((f): Content => {
    const label = { type: 'text', text: `Attached file “${f.name}”:` } as const
    if (f.kind === 'image')
      return [label, { type: 'image', source: { type: 'base64', media_type: f.mime as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: f.data } }]
    if (f.kind === 'pdf') return [label, { type: 'document', title: f.name, source: { type: 'base64', media_type: 'application/pdf', data: f.data } }]
    return [{ type: 'text', text: `<attached_file name="${f.name}">\n${f.data}${f.truncated ? '\n[…cut off here: the file is longer]' : ''}\n</attached_file>` }]
  })
}

export async function chat(cfg: ClaudeConfig, req: ChatRequest, files: ChatFileData[], emit: Emit, abort?: AbortController): Promise<Result<ChatResult>> {
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

    const message = req.quote?.trim() ? `<highlighted_passage>\n${req.quote.trim()}\n</highlighted_passage>\n\nUser: ${req.message}` : `User: ${req.message}`

    const prompt = `${context}\n\n${transcript}${message}`
    let text = ''
    let result
    try {
      result = await run(
        files.length ? [...fileBlocks(files), { type: 'text', text: prompt }] : prompt,
        baseOptions(cfg, {
          systemPrompt: CHAT_SYSTEM,
          mcpServers: { email: editor },
          ...readOnlyConnectors(['mcp__email__propose_edit', 'mcp__email__add_comment']),
          effort: 'medium',
          maxTurns: 16,
          includePartialMessages: true,
          abortController: abort,
        }),
        (m) => {
          for (const step of toolStep(m)) emit({ jobId: req.jobId, kind: 'step', text: step })
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
    } catch (err) {
      // Stopped by the user: keep what was written and suggested so far.
      if (abort?.signal.aborted) return { text: text.trim(), proposals, comments, stopped: true }
      throw err
    }
    return { text: text.trim() || result.result.trim(), proposals, comments }
  })
}

// ------------------------------------------------------------ voice learning

const VoiceSchema = z.object({
  add: z.array(z.string()).describe('New style notes: short, imperative, general. At most 3.'),
  remove: z.array(z.string()).describe('Existing notes that the edits clearly contradict, quoted exactly.'),
})

export async function learnVoice(cfg: ClaudeConfig, req: VoiceLearnRequest): Promise<Result<VoiceLearnResult>> {
  return guard(async () => {
    const result = await run(
      `<existing_notes voice="${req.voiceName}">\n${req.notes.map((n) => `- ${n}`).join('\n') || '(none)'}\n</existing_notes>\n\n<claude_draft>\n${req.draft}\n</claude_draft>\n\n<as_saved>\n${req.final}\n</as_saved>`,
      baseOptions(cfg, {
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

export async function lookupEvent(cfg: ClaudeConfig, req: EventLookupRequest, emit: Emit, abort?: AbortController): Promise<Result<EventLookupResult>> {
  return guard(async () => {
    emit({ jobId: req.jobId, kind: 'step', text: `Looking for “${req.name}”` })
    const result = await run(
      `Event: ${req.name}${req.hint ? `\nWhat the user added: ${req.hint}` : ''}`,
      baseOptions(cfg, {
        systemPrompt: `The user organises the event named below and is setting up an app that writes outreach emails (sponsors, venues, partners) for it. Find what's known about the event so they don't have to type it out.

Look in their connected tools first: search their Slack, email, docs, notes or task manager for the event name and read the most relevant threads or documents. Then check the web for a public page. Only use tools to read and search; never send, post, create or change anything. Stop once you have a clear picture; a dozen or so tool calls is plenty.

Only report what you found. If sources disagree on something that matters, don't explain it in the facts: ask the user instead. If you find nothing, return no facts and ask what the event is.

${EVENT_EXCLUDE}`,
        ...readOnlyConnectors(),
        effort: 'medium',
        maxTurns: 30,
        abortController: abort,
        ...structured(EventSchema),
      }),
      (m) => {
        for (const step of toolStep(m)) emit({ jobId: req.jobId, kind: 'step', text: step })
      },
    )
    const out = parseOutput(EventSchema, result.structured_output)
    return { details: asDetails(out.facts), questions: out.questions.filter((q) => q.question.trim()).slice(0, 4) }
  })
}

// Folds the user's answers into the event details, leaving the rest alone.
export async function applyEventAnswers(cfg: ClaudeConfig, req: EventAnswersRequest): Promise<Result<{ details: string }>> {
  return guard(async () => {
    const qa = req.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n')
    const result = await run(
      `<event>${req.name}</event>\n\n<details>\n${req.details}\n</details>\n\n<answers>\n${qa}\n</answers>`,
      baseOptions(cfg, {
        model: cfg.utilityModel,
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

export async function writingRules(cfg: ClaudeConfig, req: WritingRulesRequest): Promise<Result<{ notes: string[] }>> {
  return guard(async () => {
    const emails = req.emails.map((e, i) => `<email index="${i + 1}">\n${e.trim()}\n</email>`).join('\n')
    const result = await run(
      emails,
      baseOptions(cfg, {
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
export async function parseOrganisations(cfg: ClaudeConfig, text: string): Promise<Result<ParsedOrganisation[]>> {
  return guard(async () => {
    const result = await run(
      `<text>\n${text}\n</text>`,
      baseOptions(cfg, {
        // A quick extraction job: the utility model is plenty.
        model: cfg.utilityModel,
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

// ------------------------------------------------------------- connection

// A tiny request to check Claude is reachable with the current sign-in or key.
export async function testClaude(cfg: ClaudeConfig): Promise<Result<{ via: 'api-key' | 'claude-login' }>> {
  return guard(async () => {
    await run('Reply with just: OK', baseOptions(cfg, { tools: [], effort: 'low', maxTurns: 1 }))
    return { via: cfg.apiKey ? ('api-key' as const) : ('claude-login' as const) }
  })
}
