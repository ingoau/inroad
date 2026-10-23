import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type {
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
import { attachedText, type ChatFileData } from '../shared/chatFiles'
import type { AiConfig } from './settings'

// Runs Inroad's agent tasks through the opencode CLI instead of the Claude
// Agent SDK. `opencode run --format json` streams newline-delimited JSON events,
// which we translate into the same progress/result shapes the Claude backend
// produces. The user's own opencode install and model providers are used, but
// through a locked-down agent (see PROJECT_CONFIG) so runs stay web-only.

type Emit = (p: ClaudeProgress) => void

type OpencodeConfig = AiConfig['opencode']

// What a stopped request reports (see run).
const STOPPED = 'Stopped.'

// Quick processing jobs run on the utility model when one is set.
const utility = (cfg: OpencodeConfig): OpencodeConfig => ({ ...cfg, model: cfg.utilityModel ?? cfg.model })

// A project-local opencode config written into the agent workspace. Its "inroad"
// agent is read-only and web-only: every tool is denied except web search and
// page fetches, so it can't read the user's files or run shell commands. A step
// cap makes it answer once it has enough instead of looping on tool calls.
const PROJECT_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  agent: {
    inroad: {
      description: "Inroad's research and writing agent. Web search and page reads only.",
      mode: 'primary',
      steps: 24,
      permission: {
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
        webfetch: 'allow',
        websearch: 'allow',
      },
    },
  },
} as const

function ensureProjectConfig(workspace: string) {
  mkdirSync(workspace, { recursive: true })
  const file = join(workspace, 'opencode.json')
  const json = `${JSON.stringify(PROJECT_CONFIG, null, 2)}\n`
  try {
    if (readFileSync(file, 'utf8') === json) return
  } catch {
    // No config yet, or unreadable: write a fresh one below.
  }
  writeFileSync(file, json)
}

// --------------------------------------------------------------- running

interface Handlers {
  onText?: (text: string) => void
  onTool?: (tool: string, input: Record<string, unknown> | undefined) => void
}

// Spawns `opencode run` with the prompt on stdin and collects its output.
// Events: step_start / text / tool_use / step_finish / error. Aborting `signal`
// kills the process and rejects with STOPPED. `files` are attached to the
// message by path (opencode reads them itself, not through the agent's tools).
async function run(cfg: OpencodeConfig, prompt: string, handlers: Handlers = {}, signal?: AbortSignal, files: string[] = []): Promise<string> {
  ensureProjectConfig(cfg.workspace)
  const args = ['run', '--format', 'json', '--dir', cfg.workspace]
  if (cfg.model) args.push('-m', cfg.model)
  if (cfg.agent) args.push('--agent', cfg.agent)
  for (const f of files) args.push('--file', f)

  let text = ''
  let stderr = ''
  let failure: string | undefined

  const handle = (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return
    if (process.env.INROAD_DEBUG_OPENCODE) console.error('[opencode]', trimmed.slice(0, 600))
    let ev: { type?: string; part?: { type?: string; text?: string; tool?: string; state?: { input?: Record<string, unknown> } }; error?: { name?: string; data?: { message?: string } } }
    try {
      ev = JSON.parse(trimmed)
    } catch {
      return
    }
    if (ev.type === 'text' && ev.part?.text) {
      text += ev.part.text
      handlers.onText?.(ev.part.text)
    } else if (ev.type === 'tool_use' && ev.part?.tool) {
      handlers.onTool?.(ev.part.tool, ev.part.state?.input)
    } else if (ev.type === 'error') {
      failure ??= ev.error?.data?.message ?? ev.error?.name ?? 'opencode reported an error.'
    }
  }

  const child = spawn(cfg.executable, args, { cwd: cfg.workspace, env: { ...process.env, PWD: cfg.workspace } })
  const stop = () => child.kill()
  // Stopped before the process even started: there's no abort event left to hear.
  if (signal?.aborted) stop()
  else signal?.addEventListener('abort', stop, { once: true })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)

  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) handle(line)
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => (stderr += chunk))

  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (c) => resolve(c ?? 0))
  })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') throw new Error(`Couldn’t find opencode at “${cfg.executable}”. Install opencode or set its path in Settings.`)
      throw new Error(err.message)
    })
    .finally(() => signal?.removeEventListener('abort', stop))

  if (signal?.aborted) throw new Error(STOPPED)
  if (buffer.trim()) handle(buffer)
  if (failure) throw new Error(failure)
  if (code !== 0) throw new Error(stderr.trim() || `opencode exited with code ${code}.`)
  return text
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

const ResearchOnlySchema = z.object({
  research_notes: z.string().describe('Everything useful you found, each fact with its source URL. Kept so the email can be written later without searching again.'),
  brief: BriefSchema,
})

const ResearchDraftSchema = ResearchOnlySchema.extend(EmailFields)

const WRITING_RULES = `Write the email exactly as the user writes: follow their style notes, and treat the examples (Claude's draft vs. what they actually sent) as the strongest signal of their preferences. Use only facts from your research; never invent details, numbers, people or email addresses. Open with something specific to this organisation, make one clear ask drawn from the campaign notes, and keep it short enough to read on a phone. Address the best recipient by first name when you have one. ${GUIDANCE_RULE}`

const RESEARCH_STEPS = `Research with web search and page fetches: what the organisation does; why they'd be a good fit for what the campaign asks for; recent, specific things that would open an email well; and the best people or inboxes to contact. A handful of searches and a few page reads is usually enough. Only give an email address if it's published or very strongly evidenced, and say how you know.`

const RESEARCH_SYSTEM = `You research an organisation and write the user a personalised first-contact email to it. The user's campaign notes say what they're reaching out about and what to look for.

${RESEARCH_STEPS}

${WRITING_RULES}`

// The user turned drafting off: research and the brief, but no email yet.
const RESEARCH_ONLY_SYSTEM = `You research an organisation for the user, who may write to it later. The user's campaign notes say what they're reaching out about and what to look for. Don't write an email: turn what you find into research notes and a brief for the user to skim.

${RESEARCH_STEPS}`

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
    default:
      return tool.startsWith('mcp') ? `Checked ${tool}` : undefined
  }
}

// ------------------------------------------------- research + first draft

export async function researchAndDraft(cfg: OpencodeConfig, req: ResearchRequest, emit: Emit, abort?: AbortController): Promise<Result<ResearchResult>> {
  return guard(async () => {
    const withDraft = req.draft !== false
    emit({ jobId: req.jobId, kind: 'step', text: `Researching ${req.company}` })
    const prompt = [
      withDraft ? RESEARCH_SYSTEM : RESEARCH_ONLY_SYSTEM,
      `<campaign_notes>\n${req.campaignNotes || '(none)'}\n</campaign_notes>`,
      ...guidanceSections(req),
      voiceSection(req.voice),
      `<sender>${req.senderName || 'the user'}</sender>`,
      `Organisation: ${req.company}${req.website ? ` (website: ${req.website})` : ''}`,
    ].join('\n\n')
    const onTool = (tool: string, input: Record<string, unknown> | undefined) => {
      const step = describeTool(tool, input)
      if (step) emit({ jobId: req.jobId, kind: 'step', text: step })
    }
    if (!withDraft) {
      const out = parseJson(ResearchOnlySchema, await run(cfg, prompt + withJsonSchema(ResearchOnlySchema), { onTool }, abort?.signal))
      return { research: out.research_notes, brief: out.brief }
    }
    const text = await run(cfg, prompt + withJsonSchema(ResearchDraftSchema), { onTool }, abort?.signal)
    emit({ jobId: req.jobId, kind: 'step', text: 'Writing draft' })
    const out = parseJson(ResearchDraftSchema, text)
    return {
      research: out.research_notes,
      brief: out.brief,
      draft: { to: out.to, subject: out.subject, body: out.body, comments: anchored(out.body, out.comments) },
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
    const out = parseJson(DraftSchema, await run(cfg, prompt + withJsonSchema(DraftSchema)))
    return { ...out, comments: anchored(out.body, out.comments) }
  })
}

// ------------------------------------------------------------------- chat

const CHAT_SYSTEM = `You help the user refine one outreach email. You can see the email, the research brief, the campaign notes, any email format and instructions for this organisation, and the user's voice. Keep the email within the format and instructions unless the user asks otherwise.

The email body is markdown, exactly as stored: ${MARKDOWN} Links and formatting are part of the text you see and can change.

The user may point at a passage they highlighted in the email; it's quoted with their message. Read it as "this part", and keep any edits to it unless they ask for more.

The user can attach files to their messages: images (screenshots, photos, flyers), PDFs and text files. They're attached to this message (text files are included inline, labelled with their name), and the messages that attached them say so. Use them as the user intends, e.g. a screenshot of an email thread to reply to, a prospectus to draw facts from, or a photo to describe.

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

export async function chat(cfg: OpencodeConfig, req: ChatRequest, files: ChatFileData[], emit: Emit, abort?: AbortController): Promise<Result<ChatResult>> {
  return guard(async () => {
    // Images and PDFs go to opencode by path; text files are simplest inline.
    const texts = files.filter((f) => f.kind === 'text').map(attachedText)
    const context = [
      CHAT_SYSTEM,
      ...texts,
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

    const message = req.quote?.trim() ? `<highlighted_passage>\n${req.quote.trim()}\n</highlighted_passage>\n\nUser: ${req.message}` : `User: ${req.message}`

    let streamed = ''
    let text: string
    try {
      text = await run(
        cfg,
        `${context}\n\n${transcript}${message}`,
        {
          onText: (chunk) => {
            streamed += chunk
            emit({ jobId: req.jobId, kind: 'delta', text: chunk })
          },
          onTool: (tool, input) => {
            const step = describeTool(tool, input)
            if (step) emit({ jobId: req.jobId, kind: 'step', text: step })
          },
        },
        abort?.signal,
        files.filter((f) => f.kind !== 'text').map((f) => f.path),
      )
    } catch (err) {
      // Stopped by the user: keep what was written so far.
      if (abort?.signal.aborted) return { ...takeEdits(streamed, req.subject, req.body), stopped: true }
      throw err
    }
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
    const text = await run(cfg, prompt + withJsonSchema(VoiceSchema))
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

export async function lookupEvent(cfg: OpencodeConfig, req: EventLookupRequest, emit: Emit, abort?: AbortController): Promise<Result<EventLookupResult>> {
  return guard(async () => {
    emit({ jobId: req.jobId, kind: 'step', text: `Looking for “${req.name}”` })
    const prompt = [
      `The user organises the event named below and is setting up an app that writes outreach emails (sponsors, venues, partners) for it. Find what's known about the event so they don't have to type it out.

Search the web for the event: its own site and social posts, who runs it, dates, venue, who attends and roughly how many, past editions and numbers, and what organisers ask partners for. Only read pages; never submit a form, post, sign up or change anything. Stop once you have a clear picture; a dozen or so page reads is plenty.

Only report what you found. If sources disagree on something that matters, don't explain it in the details: ask the user instead. If you find nothing, leave the details empty and ask what the event is. Never write "unknown": leave a fact out, or ask about it if it matters.

Leave out: sources, citations and where you found anything; outreach already sent or drafted and sponsors already confirmed; other people working on the event and their contact details; internal logistics (insurance, budget, hire agreements, to-dos); notes about tools or access. Public links to the event's own site or social pages are fine.`,
      `Event: ${req.name}${req.hint ? `\nWhat the user added: ${req.hint}` : ''}`,
    ].join('\n\n')
    const text = await run(
      cfg,
      prompt + withJsonSchema(EventSchema),
      {
        onTool: (tool, input) => {
          const step = describeTool(tool, input)
          if (step) emit({ jobId: req.jobId, kind: 'step', text: step })
        },
      },
      abort?.signal,
    )
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
    const text = await run(utility(cfg), prompt + withJsonSchema(z.object({ details: z.string() })))
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
    const text = await run(cfg, prompt + withJsonSchema(RulesSchema))
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
    const out = parseJson(OrganisationsSchema, await run(utility(cfg), prompt + withJsonSchema(OrganisationsSchema)))
    return out.organisations.map((o) => ({ name: o.name.trim(), website: o.website.trim(), note: o.note.trim() })).filter((o) => o.name)
  })
}

// ------------------------------------------------------------- connection

export async function testOpencode(cfg: OpencodeConfig): Promise<Result<{ via: 'opencode' }>> {
  return guard(async () => {
    await run(cfg, 'Reply with just: OK')
    return { via: 'opencode' as const }
  })
}
