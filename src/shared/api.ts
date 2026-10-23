// The surface the preload script exposes to the renderer as `window.api`.
// Kept small and explicit: the renderer never gets raw ipcRenderer access.

// ---- Research brief (written by Claude, shown in the Brief panel) ----
export interface Recipient {
  name: string
  role: string
  // Empty when no address was found.
  email: string
  confidence: 'high' | 'medium' | 'low'
  source: string
}

export interface Brief {
  summary: string
  // Headings are chosen to suit the campaign, e.g. "Past sponsorships" for
  // sponsors, "Capacity & facilities" for venues.
  sections: { title: string; items: string[] }[]
  recipients: Recipient[]
  sources: { title: string; url: string }[]
}

// ---- Claude requests ----
export interface VoiceInput {
  name: string
  notes: string[]
  // Emails the user wrote: either Claude's draft and what they saved
  // instead, or (no draft) one they pasted in.
  examples: { draft?: string; final: string }[]
}

// Firm requirements for an email, on top of the campaign notes.
export interface EmailGuidance {
  // The campaign's "Email format": structure and must-haves for every email.
  emailFormat?: string
  // What the user said about this one organisation, e.g. "mention they sponsored Campfire".
  orgNote?: string
}

export interface ResearchRequest extends EmailGuidance {
  jobId: string
  company: string
  website?: string
  campaignNotes: string
  voice: VoiceInput
  senderName: string
  // False to research and write the brief only, leaving the email for later.
  draft?: boolean
  // Why "Find with AI" suggested this organisation, with sources: a head start
  // for research, not instructions.
  discovery?: string
}

export interface ResearchResult {
  // Free-form findings with source URLs; kept so redrafting doesn't re-search.
  research: string
  brief: Brief
  // Missing when the request asked for research only.
  draft?: EmailDraft
}

export interface DraftRequest extends EmailGuidance {
  company: string
  campaignNotes: string
  research: string
  voice: VoiceInput
  senderName: string
  // When regenerating: the draft to move away from.
  previousDraft?: string
}

// Claude's remark on one passage of an email.
export interface EmailComment {
  // Exact text from the body (markdown, within one paragraph).
  quote: string
  comment: string
  // verify: a fact to double-check. note: why something is there.
  kind: 'verify' | 'note'
}

export interface EmailDraft {
  // The recipient Claude thinks is best, or '' if none has an address.
  to: string
  subject: string
  // Markdown (the same dialect the app stores; see markdown.ts).
  body: string
  comments: EmailComment[]
}

export interface DraftResult extends EmailDraft {
  brief: Brief
}

export interface ChatRequest extends EmailGuidance {
  jobId: string
  // Comments already on the email, so Claude doesn't repeat them.
  comments?: EmailComment[]
  company: string
  campaignNotes: string
  brief?: Brief
  voice: VoiceInput
  subject: string
  // The email body as markdown; suggested edits quote from this.
  body: string
  history: { role: 'user' | 'assistant'; text: string }[]
  message: string
  // A passage of the email the user highlighted to ask about.
  quote?: string
}

export interface ProposedEdit {
  old: string
  new: string
  reason: string
}

export interface ChatResult {
  text: string
  proposals: ProposedEdit[]
  comments: EmailComment[]
  // The user stopped the reply; this is what was written up to then.
  stopped?: boolean
}

// Onboarding: find what's known about the user's event, via the web and any
// connectors (Slack, email…) on their Claude account.
export interface EventLookupRequest {
  jobId: string
  name: string
  // Anything else the user typed, e.g. "UNSW, November".
  hint?: string
}

// Something only the user can settle, e.g. two sources disagree.
export interface EventQuestion {
  question: string
  // Likely answers to pick from; the user can also type their own.
  options: string[]
}

export interface EventLookupResult {
  // Context for every email: one "Label: value" line per fact.
  details: string
  questions: EventQuestion[]
}

export interface EventAnswersRequest {
  name: string
  // The current shared context (may include the user's own text).
  details: string
  answers: { question: string; answer: string }[]
}

// Onboarding: style notes drawn from emails the user wrote.
export interface WritingRulesRequest {
  emails: string[]
}

// Adding organisations: free text split into organisations by Claude.
export interface ParsedOrganisation {
  name: string
  // '' if none was given.
  website: string
  // Instructions for just this organisation, '' if none.
  note: string
}

// Adding organisations: "Find with AI" searches for organisations that suit
// the campaign, one round per query.
export interface DiscoverRequest {
  jobId: string
  query: string
  campaignNotes: string
  // Already in the campaign, already suggested or dismissed: don't suggest again.
  exclude: string[]
  // Earlier queries in this search, oldest first, so "10 more" or "Australian
  // only" can build on them.
  earlier: string[]
}

export interface Candidate {
  name: string
  // '' if none was found.
  website: string
  // One line on why they suit this campaign.
  why: string
  fit: 'strong' | 'possible'
  sources: { title: string; url: string }[]
}

export interface VoiceLearnRequest {
  voiceName: string
  notes: string[]
  draft: string
  final: string
}

export interface VoiceLearnResult {
  add: string[]
  // Existing notes the edits contradict, quoted exactly.
  remove: string[]
}

// Streamed while a request runs: research steps, or chat text as it arrives.
// Discovery also streams each organisation as it's found.
export type ClaudeProgress =
  { jobId: string; kind: 'step'; text: string } | { jobId: string; kind: 'delta'; text: string } | { jobId: string; kind: 'candidate'; candidate: Candidate }

export interface MailSettings {
  host: string
  port: number
  // true = implicit TLS (usually port 993); false = STARTTLS.
  secure: boolean
  user: string
  fromName: string
  fromEmail: string
  // Added as Bcc to every draft, e.g. a CRM's logging address. Comma-separated; empty for none.
  bcc?: string
}

// Which agent backend Inroad runs.
export type AiProvider = 'claude' | 'opencode'

// Which Claude models Inroad runs. Empty means Inroad's default.
export interface ClaudeModels {
  // Research, drafting, chat and event lookup.
  model: string
  // Quick processing jobs: splitting a typed list into organisations, folding
  // answers into the event details.
  utilityModel: string
}

// How Inroad reaches the opencode CLI. Empty path means "opencode" on PATH.
export interface OpencodeSettings {
  path: string
  // provider/model for research, drafting and chat; empty uses opencode's default.
  model: string
  // provider/model for quick processing jobs; empty uses the model above.
  utilityModel: string
  agent: string
}

// What the renderer sees: secrets are never sent back, only whether they're set.
export interface PublicSettings {
  mail: MailSettings | null
  hasMailPassword: boolean
  // Optional: without one, Claude runs on this computer's Claude Code sign-in.
  hasAnthropicKey: boolean
  aiProvider: AiProvider
  claude: ClaudeModels
  opencode: OpencodeSettings
  // False when the OS has no keychain, so secrets are stored unencrypted locally.
  secureStorage: boolean
}

export interface SettingsPatch {
  mail?: MailSettings
  mailPassword?: string
  anthropicKey?: string
  aiProvider?: AiProvider
  claudeModel?: string
  claudeUtilityModel?: string
  opencodePath?: string
  opencodeModel?: string
  opencodeUtilityModel?: string
  opencodeAgent?: string
}

// A file attached to a campaign's emails. Picked files are copied into
// Inroad's own folder, so moving or deleting the original doesn't break it.
export interface Attachment {
  id: string
  name: string
  size: number
}

export interface DraftInput {
  to: string[]
  subject: string
  html: string
  text: string
  attachments: Attachment[]
}

// Enough to find the draft again (to replace or delete it).
export interface DraftRef {
  mailbox: string
  messageId: string
  // When it reached the mailbox. Missing on drafts saved by older versions.
  savedAt?: number
}

// A saved draft to look for: still in Drafts, or sent from the mail app.
export interface SentCheck {
  id: string
  ref: DraftRef
  // Who the draft was to, for spotting the sent copy when the mail app gave it a new Message-ID.
  to: string[]
  // When the draft was saved; anything sent to them before then isn't it.
  savedAt: number
}

// draft: still in Drafts. sent: found in the Sent folder (at: when it was sent).
// missing: gone from Drafts but not in Sent, so deleted, scheduled or still sending.
export type SentState = { state: 'draft' } | { state: 'sent'; at: number } | { state: 'missing' }

export type Result<T> ={ ok: true; value: T } | { ok: false; error: string }

export interface InroadApi {
  // process.platform, e.g. 'darwin'.
  platform: string
  store: {
    // Returns the saved app state, or null on first run.
    load: () => Promise<unknown | null>
    save: (data: unknown) => Promise<void>
  }
  settings: {
    get: () => Promise<PublicSettings>
    set: (patch: SettingsPatch) => Promise<PublicSettings>
  }
  claude: {
    // Checks the agent backend is reachable: the API key or Claude Code sign-in,
    // or the opencode CLI when that's the chosen provider.
    test: () => Promise<Result<{ via: 'api-key' | 'claude-login' | 'opencode' }>>
    research: (req: ResearchRequest) => Promise<Result<ResearchResult>>
    draft: (req: DraftRequest) => Promise<Result<DraftResult>>
    chat: (req: ChatRequest) => Promise<Result<ChatResult>>
    learnVoice: (req: VoiceLearnRequest) => Promise<Result<VoiceLearnResult>>
    lookupEvent: (req: EventLookupRequest) => Promise<Result<EventLookupResult>>
    // Folds the user's answers into the details.
    applyEventAnswers: (req: EventAnswersRequest) => Promise<Result<{ details: string }>>
    writingRules: (req: WritingRulesRequest) => Promise<Result<{ notes: string[] }>>
    parseOrganisations: (text: string) => Promise<Result<ParsedOrganisation[]>>
    // Every organisation found, including those already streamed as progress.
    discover: (req: DiscoverRequest) => Promise<Result<Candidate[]>>
    // Stops a running research, chat, discovery or event lookup by its jobId.
    cancel: (jobId: string) => Promise<void>
    // Subscribe to progress for running requests; returns an unsubscribe function.
    onProgress: (cb: (p: ClaudeProgress) => void) => () => void
  }
  files: {
    // Opens the system file picker; resolves to [] if cancelled.
    pickAttachments: () => Promise<Attachment[]>
  }
  mail: {
    // Connects with the saved settings and reports the Drafts folder it found.
    test: () => Promise<Result<{ draftsMailbox: string }>>
    saveDraft: (draft: DraftInput) => Promise<Result<DraftRef>>
    deleteDraft: (ref: DraftRef) => Promise<Result<null>>
    // Looks each draft up in Drafts and then Sent, by id. Ones it can't decide
    // (e.g. no Sent folder) are left out.
    checkSent: (checks: SentCheck[]) => Promise<Result<Record<string, SentState>>>
  }
}
