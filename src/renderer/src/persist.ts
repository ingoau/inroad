import { firstRunCampaign, firstRunFolder, firstRunVoice, type Campaign, type Folder, type Prospect, type Snippet, type Version, type Voice } from './data'
import { htmlToMarkdown, looksLikeHtml, type EmailStyle } from './markdown'

// Everything worth keeping between launches. UI-only state (open panels,
// filters, theme) lives elsewhere.
export interface SavedState {
  version: 1
  prospects: Prospect[]
  folders: Folder[]
  campaigns: Campaign[]
  voices: Voice[]
  campaignId: string
  selectedId: string
  // Before folders, one event was shared by every campaign; it becomes the first folder.
  event?: { name: string; details: string }
  // False until the first-run setup is finished (or skipped).
  onboarded?: boolean
  // How saved emails look (Settings → Email style).
  emailStyle?: EmailStyle
  // Settings → Snippets. Missing in saves from before snippets.
  snippets?: Snippet[]
}

export function firstRun(): SavedState {
  const voice = firstRunVoice()
  const folder = firstRunFolder()
  const campaign = firstRunCampaign(folder.id, voice.id)
  return {
    version: 1,
    prospects: [],
    folders: [folder],
    campaigns: [campaign],
    voices: [voice],
    campaignId: campaign.id,
    selectedId: '',
    onboarded: false,
    snippets: [],
  }
}

// Saves from before folders: put every campaign in one folder made from the
// old shared event. Safe to run on state that already has folders.
export function withFolders(state: SavedState): SavedState {
  const folders = state.folders?.length
    ? state.folders
    : [{ id: crypto.randomUUID(), name: state.event?.name || 'My event', notes: state.event?.details ?? '' }]
  return {
    ...state,
    folders,
    event: undefined,
    campaigns: state.campaigns.map((c) => ({ ...c, folderId: folders.some((f) => f.id === c.folderId) ? c.folderId : folders[0].id })),
  }
}

// Bodies saved before markdown were HTML; convert them once.
function withMarkdown(state: SavedState): SavedState {
  const md = (s: string) => (looksLikeHtml(s) ? htmlToMarkdown(s) : s)
  return {
    ...state,
    prospects: state.prospects.map((p) => ({
      ...p,
      body: md(p.body),
      originalBody: md(p.originalBody),
      versions: p.versions.map((v) => {
        const old = v as Version & { html?: string }
        return { ...v, markdown: v.markdown ?? md(old.html ?? '') }
      }),
    })),
  }
}

// Brings state saved by any earlier version up to date. Safe to run twice.
export const upgrade = (state: SavedState) => withMarkdown(withFolders(state))

// Claude work doesn't survive a restart: research that was running goes back
// in the queue, and a chat reply that was being written is marked as cut off.
function resume(saved: SavedState): SavedState {
  const state = upgrade(saved)
  return {
    ...state,
    // Older saves stored attachments as bare file names with no file behind them.
    campaigns: state.campaigns.map((c) => ({ ...c, attachments: c.attachments.filter((a) => typeof a === 'object') })),
    voices: state.voices.map((v) => ({ ...v, examples: v.examples?.map((e) => ({ ...e, id: e.id ?? crypto.randomUUID(), at: e.at ?? Date.now() })) })),
    prospects: state.prospects.map((p) => ({
      ...p,
      status: p.status === 'researching' ? 'queued' : p.status,
      chats: p.chats.map((c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.pending ? { ...m, pending: false, step: undefined, error: true, text: m.text || 'Interrupted when Inroad closed.' } : m,
        ),
      })),
    })),
  }
}

export async function loadSaved(): Promise<SavedState> {
  const saved = (await window.api?.store.load()) as SavedState | null | undefined
  return saved?.version === 1 ? resume(saved) : firstRun()
}

// Debounced so typing in the editor doesn't write the file on every keystroke.
let timer: ReturnType<typeof setTimeout> | undefined
export function persist(state: SavedState) {
  if (!window.api) return
  clearTimeout(timer)
  timer = setTimeout(() => window.api!.store.save(state).catch((err) => console.error('Failed to save', err)), 400)
}
