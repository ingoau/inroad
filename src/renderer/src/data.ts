import type { Attachment, Brief, DraftRef, EmailComment, Recipient } from '../../shared/api'

export type { Attachment, Brief, Recipient }

// researched: the campaign is research-only, so there's a brief but no email yet.
export type Status = 'queued' | 'researching' | 'researched' | 'drafted' | 'edited' | 'saved' | 'failed'

export interface Proposal {
  id: string
  old: string
  new: string
  reason: string
  state: 'pending' | 'accepted' | 'rejected'
}

export interface ChatMsg {
  id: string
  role: 'user' | 'assistant'
  text: string
  // The passage of the email the user highlighted to ask about.
  quote?: string
  proposals?: Proposal[]
  // Comments this reply pinned to the email (also stored on the prospect).
  comments?: EmailComment[]
  // Claude is still writing this reply.
  pending?: boolean
  // While pending: what it's doing right now, e.g. "Checked Slack".
  step?: string
  // The user stopped this reply part-way.
  stopped?: boolean
  // The reply failed; text holds the reason.
  error?: boolean
}

// One of Claude's comments on the email, pinned to a phrase.
export interface Comment extends EmailComment {
  id: string
  // Written with the draft, or added in chat.
  by: 'draft' | 'chat'
  at: number
  dismissed?: boolean
}

export interface Version {
  id: string
  label: string
  by: 'claude' | 'you'
  at: number
  // The email body at that point, as markdown.
  markdown: string
  deletedAt?: number
}

// One conversation with Claude about an email. An email can have several.
export interface ChatThread {
  id: string
  title: string
  createdAt: number
  messages: ChatMsg[]
  deletedAt?: number
}

export interface Prospect {
  id: string
  campaignId: string
  company: string
  // Website, if given or found. Helps research find the right organisation.
  domain: string
  // What the user said about this organisation ("mention they sponsored
  // Campfire"). Claude follows it for research, drafting and chat.
  note?: string
  status: Status
  progress: string[]
  error?: string
  brief?: Brief
  // Claude's research notes with sources, so redrafting doesn't search again.
  research?: string
  subject: string
  // Email bodies are markdown (see markdown.ts). originalBody is Claude's
  // latest draft, body is the current text.
  originalBody: string
  body: string
  to: string[]
  chats: ChatThread[]
  activeChatId?: string
  // Every draft Claude wrote, your edits before a regenerate, and each save.
  versions: Version[]
  comments?: Comment[]
  // Soft delete: set when moved to Deleted items, cleared on restore.
  deletedAt?: number
  // The copy in the mailbox's Drafts folder, once saved there.
  draftRef?: DraftRef
}

// A group of campaigns that share context, e.g. one event with Venues and
// Sponsors campaigns in it.
export interface Folder {
  id: string
  name: string
  // What every campaign in the folder should know: what the event is, when
  // and where, numbers, links.
  notes: string
  deletedAt?: number
}

export interface Campaign {
  id: string
  folderId: string
  name: string
  // Freeform: who you're contacting, what you're asking for, what to research,
  // tone. Read after the folder's notes for every email in the campaign.
  notes: string
  // Structure and must-haves for every email in the campaign. Claude treats
  // this as a requirement, unlike the notes.
  format?: string
  // Added to every email in this campaign when it's saved to Drafts.
  attachments: Attachment[]
  // Which voice profile drafts in this campaign are written in.
  voiceId: string
  // Research and write the brief only; emails are drafted one at a time on request.
  researchOnly?: boolean
  deletedAt?: number
}

// Reusable text for the email editor, inserted by typing "/". Available
// everywhere, in one folder's campaigns, or in one campaign.
export interface Snippet {
  id: string
  name: string
  // Markdown, like email bodies.
  text: string
  scope: { kind: 'global' } | { kind: 'folder'; id: string } | { kind: 'campaign'; id: string }
  deletedAt?: number
}

// The snippets an email in this campaign can use, most specific first.
export function snippetsFor(snippets: Snippet[], campaign: Pick<Campaign, 'id' | 'folderId'>): Snippet[] {
  const rank = (s: Snippet) => (s.scope.kind === 'campaign' ? 0 : s.scope.kind === 'folder' ? 1 : 2)
  return snippets
    .filter(
      (s) =>
        !s.deletedAt &&
        (s.scope.kind === 'global' || (s.scope.kind === 'folder' && s.scope.id === campaign.folderId) || (s.scope.kind === 'campaign' && s.scope.id === campaign.id)),
    )
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export interface Voice {
  id: string
  name: string
  description: string
  notes: { text: string; fresh: boolean; deletedAt?: number }[]
  // Shown to Claude as examples of how you actually write (oldest first).
  examples?: VoiceExample[]
  deletedAt?: number
}

export interface VoiceExample {
  id: string
  at: number
  // Claude's draft, when this came from saving an edited email. Pasted
  // emails have none.
  draft?: string
  final: string
  deletedAt?: number
}

// How many saved edits Claude sees as examples (the newest). Pasted emails are always included.
export const MAX_VOICE_EXAMPLES = 4

export const firstRunFolder = (): Folder => ({ id: crypto.randomUUID(), name: '', notes: '' })

export const firstRunCampaign = (folderId: string, voiceId: string): Campaign => ({
  id: crypto.randomUUID(),
  folderId,
  name: 'Sponsors',
  notes: '',
  attachments: [],
  voiceId,
})

export const firstRunVoice = (): Voice => ({
  id: crypto.randomUUID(),
  name: 'My voice',
  description: 'Learns from the edits you make before saving',
  notes: [],
})
