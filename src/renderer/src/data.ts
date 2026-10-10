import type { Attachment, Brief, DraftRef, EmailComment, Recipient } from '../../shared/api'

export type { Attachment, Brief, Recipient }

export type Status = 'queued' | 'researching' | 'drafted' | 'edited' | 'saved' | 'failed'

export interface Proposal {
  id: string
  old: string
  new: string
  reason: string
  state: 'pending' | 'accepted' | 'rejected'
}

// One fan-out research sub-agent's live activity, shown in its own column.
export interface SubagentRun {
  label: string
  steps: string[]
  done?: boolean
}

export interface ChatMsg {
  id: string
  role: 'user' | 'assistant'
  text: string
  proposals?: Proposal[]
  // Comments this reply pinned to the email (also stored on the prospect).
  comments?: EmailComment[]
  // Claude is still writing this reply.
  pending?: boolean
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
  // Live columns while research fans out to sub-agents (cleared with progress).
  subagents?: SubagentRun[]
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
  deletedAt?: number
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
