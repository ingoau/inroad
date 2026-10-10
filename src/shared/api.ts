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
}

export interface ResearchResult {
  // Free-form findings with source URLs; kept so redrafting doesn't re-search.
  research: string
  draft: DraftResult
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

export interface DraftResult {
  brief: Brief
  // The recipient Claude thinks is best, or '' if none has an address.
  to: string
  subject: string
  // Markdown (the same dialect the app stores; see markdown.ts).
  body: string
  comments: EmailComment[]
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

// ---- The opencode agent's mid-run question tool ----
// The opencode backend can pause a run to ask the user something, the same way
// its own CLI does. This is separate from EventQuestion above, which is a
// post-run list folded into the event details.
export interface AgentQuestionOption {
  label: string
  description?: string
}

export interface AgentQuestion {
  question: string
  // A short heading the agent may suggest, e.g. "Venue".
  header?: string
  // Answers to pick from. Empty means an open question.
  options: AgentQuestionOption[]
  // Whether more than one option can be chosen.
  multiple?: boolean
  // Whether the user may type their own answer. Defaults to true.
  custom?: boolean
}

// One pending question: the run is paused until it's answered or skipped.
export interface AgentQuestionRequest {
  // opencode's own id, used when replying.
  requestId: string
  // What the agent was doing, e.g. "Researching Canva", shown as context.
  context: string
  questions: AgentQuestion[]
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

// Adding organisations: let the agent propose organisations to reach, based on
// the folder's event info and the campaign's notes.
export interface LeadSuggestionsRequest {
  jobId: string
  // The folder's shared context: what the event is.
  eventInfo: string
  // The campaign's notes: who you're contacting and what you're asking for.
  campaignNotes: string
  // The campaign's email format, if set.
  emailFormat?: string
  // Organisations already in the campaign, so they aren't suggested again.
  existing?: string[]
  // How many to suggest. Defaults to 8.
  count?: number
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

// Streamed while a request runs: research steps, chat text as it arrives, or
// what one fan-out research sub-agent is doing (subagent indexes the column).
export type ClaudeProgress =
  | { jobId: string; kind: 'step'; text: string }
  | { jobId: string; kind: 'delta'; text: string }
  | { jobId: string; kind: 'subagent'; subagent: number; label: string; text: string; done?: boolean }

export interface MailSettings {
  host: string
  port: number
  // true = implicit TLS (usually port 993); false = STARTTLS.
  secure: boolean
  user: string
  fromName: string
  fromEmail: string
}

// Which agent backend Inroad runs.
export type AiProvider = 'claude' | 'opencode'

// How Inroad reaches the opencode CLI. Empty path means "opencode" on PATH.
export interface OpencodeSettings {
  path: string
  // Default model for any task without its own model below.
  model: string
  // Overrides for the two main flows, falling back to `model` when blank.
  researchModel: string
  chatModel: string
  // Tried once if the chosen model fails a request, e.g. when a provider runs
  // out of usage. Empty disables the fallback.
  fallbackModel: string
  agent: string
  // When set, research fans out to three parallel sub-agents running this model.
  subAgentModel: string
}

// One environment variable or HTTP header. Kept as an ordered list so the UI can
// edit rows (and blank ones) without object keys colliding.
export interface McpKeyValue {
  key: string
  value: string
}

// A Model Context Protocol server the agent can use, added in Settings → AI
// agent. Local ("stdio") servers run a command; remote servers connect to a URL.
export interface McpServer {
  id: string
  name: string
  transport: 'stdio' | 'http' | 'sse'
  // stdio only: the command to run and its arguments (one per line in the UI).
  command: string
  args: string[]
  // stdio only: environment variables passed to the server process.
  env: McpKeyValue[]
  // http/sse only: the server URL.
  url: string
  // http/sse only: request headers.
  headers: McpKeyValue[]
  // Whether the agent connects to it. A server can stay configured but off.
  enabled: boolean
}

// The key a server is stored under in Claude and opencode config. It's the
// server's own name, unsanitized, so OAuth tokens the CLIs already saved (keyed
// by the original name) are found and reused instead of being re-authenticated.
export function mcpServerKey(s: McpServer): string {
  return s.name.trim() || s.id
}

// An MCP server found in the user's existing Claude Code or opencode setup,
// offered so they can add it to Inroad without retyping it.
export interface DiscoveredMcpServer {
  server: McpServer
  // Which setup it came from, e.g. "Claude Code" or "opencode".
  source: string
  // Where in that setup, e.g. "user settings" or a project path.
  scope: string
  // Whether that setup already has an OAuth token for this server.
  authenticated: boolean
}

// How a remote MCP server's OAuth sign-in is doing. 'connected' means a token
// is stored; 'needs-auth' means the CLI has flagged it; 'unknown' means we
// can't tell without connecting; 'failed' means the last attempt errored.
export type McpAuthState = 'connected' | 'needs-auth' | 'failed' | 'unknown'

export interface McpAuthStatus {
  // Matches McpServer.id.
  id: string
  state: McpAuthState
  // Extra context for the UI, e.g. why a sign-in failed.
  detail?: string
}

// What the renderer sees: secrets are never sent back, only whether they're set.
export interface PublicSettings {
  mail: MailSettings | null
  hasMailPassword: boolean
  // Optional: without one, Claude runs on this computer's Claude Code sign-in.
  hasAnthropicKey: boolean
  aiProvider: AiProvider
  opencode: OpencodeSettings
  // MCP servers the agent may connect to (Settings → AI agent).
  mcpServers: McpServer[]
  // False when the OS has no keychain, so secrets are stored unencrypted locally.
  secureStorage: boolean
  // Desktop notifications when research finishes or the agent has questions
  // (Settings → AI agent). Off by default, and only while the window is unfocused.
  desktopNotifications: boolean
}

export interface SettingsPatch {
  mail?: MailSettings
  mailPassword?: string
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
  mcpServers?: McpServer[]
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
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

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
    // Suggests organisations to reach, from the folder's event info and the
    // campaign's notes. Same shape as parseOrganisations.
    suggestLeads: (req: LeadSuggestionsRequest) => Promise<Result<ParsedOrganisation[]>>
    // Subscribe to progress for running requests; returns an unsubscribe function.
    onProgress: (cb: (p: ClaudeProgress) => void) => () => void
  }
  agent: {
    // Fires when a running opencode agent asks the user a question; the run is
    // paused until answer() or skip (empty answers) is called.
    onQuestion: (cb: (req: AgentQuestionRequest) => void) => () => void
    // Questions still waiting, so a reloaded window can show them again.
    pendingQuestions: () => Promise<AgentQuestionRequest[]>
    // One array of answers per question; an empty array means "unanswered".
    answer: (requestId: string, answers: string[][]) => Promise<Result<null>>
  }
  files: {
    // Opens the system file picker; resolves to [] if cancelled.
    pickAttachments: () => Promise<Attachment[]>
  }
  mcp: {
    // MCP servers already configured on this computer (Claude Code / opencode).
    discover: () => Promise<DiscoveredMcpServer[]>
    // OAuth sign-in state for the configured remote servers, for the current provider.
    authStatus: () => Promise<McpAuthStatus[]>
    // Starts an OAuth sign-in (opens the browser); resolves once it completes.
    authenticate: (serverId: string) => Promise<Result<McpAuthStatus>>
    // Removes this server's stored OAuth token.
    logout: (serverId: string) => Promise<Result<McpAuthStatus>>
  }
  mail: {
    // Connects with the saved settings and reports the Drafts folder it found.
    test: () => Promise<Result<{ draftsMailbox: string }>>
    saveDraft: (draft: DraftInput) => Promise<Result<DraftRef>>
    deleteDraft: (ref: DraftRef) => Promise<Result<null>>
  }
}
