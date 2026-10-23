import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import {
  Archive,
  ArchiveRestore,
  Copy,
  FileText,
  FolderOpen,
  FolderPlus,
  Flag,
  GitCompare,
  Inbox,
  Keyboard,
  MessageSquare,
  MessageSquarePlus,
  Moon,
  PanelLeft,
  PanelRight,
  PenLine,
  Plus,
  Redo2,
  RefreshCw,
  Send,
  Settings,
  Slash,
  Sparkles,
  Square,
  Sun,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { toast } from 'sonner'
import { AgentProvider } from './agent'
import { CommandPalette, ShortcutsDialog, type PaletteCommand } from './components/CommandPalette'
import { AddCompaniesPage } from './components/AddCompaniesPage'
import { Shortcut } from './components/hint'
import { TopBar } from './components/TopBar'
import { Editor } from './components/Editor'
import { activeChat, RightPanel, type Tab } from './components/RightPanel'
import type { TrashItem } from './components/TrashView'
import { SettingsSidebar, type SettingsPage } from './components/settings/SettingsSidebar'
import { SettingsView } from './components/settings/SettingsView'
import { AppSidebar, dot, inFilter, type Filter } from './components/Sidebar'
import { statusStyle } from './components/status'
import { useBreakpoint } from './layout'
import {
  MAX_VOICE_EXAMPLES,
  hasEmail,
  isDone,
  type Status,
  snippetsFor,
  statusAfter,
  type Attachment,
  type Campaign,
  type Candidate,
  type Discovery,
  type DiscoveryRound,
  type ChatMsg,
  type Comment,
  type Folder,
  type ChatThread,
  type Prospect,
  type Snippet,
  type Version,
  type Voice,
  type VoiceExample,
} from './data'
import type { ClaudeProgress, DraftRef, EmailComment, PublicSettings, SentCheck, VoiceInput } from '../../shared/api'
import { orgKey } from '../../shared/org'
import { firstRun, persist, upgrade, type SavedState } from './persist'
import type { ChatAttachment } from './chatFiles'
import { CHAT_TOTAL_MAX } from '../../shared/chatFiles'
import { defaultEmailStyle, emailHtml, emailStyleVars, markdownToText, normalizeMarkdown, type EmailStyle } from './markdown'
import { Onboarding, type OnboardingResult } from './components/Onboarding'
import { currentEditor, historyDepth, undoBridge, type UndoEntry } from './undo'

const MAX_CONCURRENT = 3
// How long a save is held back before it touches the mailbox; undoing inside
// this window cancels it rather than having to delete the draft.
const UNDO_GRACE_MS = 5000
// How often saved drafts are looked for in Sent while Inroad is open (also on focus).
const SENT_CHECK_MS = 3 * 60_000
type Theme = 'dark' | 'light'

// What save-and-next and N move on to: drafts to review, and research-only emails still to write.
const needsReview = (p: Prospect) => (inFilter.review(p) && p.status !== 'failed') || inFilter.write(p)
// Claude's comments, stamped for storing on a prospect.
const stamp = (comments: EmailComment[], by: Comment['by']): Comment[] => comments.map((c) => ({ ...c, id: crypto.randomUUID(), by, at: Date.now() }))

const hasText = (p: Prospect | undefined, text: string) => !!p && !!text && (p.subject.includes(text) || p.body.includes(text))

interface Toast {
  text: string
  undo?: boolean
  redo?: boolean
  action?: { label: string; run: () => void }
}

// What one save taught Claude about how you write, so it can be undone.
interface VoiceChange {
  voiceId: string
  at: number
  add: string[]
  remove: string[]
  example: VoiceExample
}

function loadTheme(): Theme {
  try {
    return localStorage.getItem('theme') === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

export default function App({ saved: loaded }: { saved: SavedState }) {
  // Hot reloads can hand back state loaded by older code (before folders, or HTML bodies).
  const [saved] = useState(() => upgrade(loaded))
  const [prospects, setProspects] = useState(saved.prospects)
  const [folders, setFolders] = useState(saved.folders)
  const [campaigns, setCampaigns] = useState(saved.campaigns)
  const [voices, setVoices] = useState(saved.voices)
  const [snippets, setSnippets] = useState<Snippet[]>(saved.snippets ?? [])
  // The email workspace, adding organisations, or Settings (which swaps in its own sidebar).
  const [view, setView] = useState<'email' | 'add' | 'settings'>('email')
  const [settingsPage, setSettingsPage] = useState<SettingsPage>({ kind: 'mailbox' })
  const [campaignId, setCampaignId] = useState(saved.campaignId)
  const [selectedId, setSelectedId] = useState(saved.selectedId)
  // Saves from before onboarding existed count as onboarded.
  const [onboarded, setOnboarded] = useState(saved.onboarded !== false)
  const [emailStyle, setEmailStyle] = useState<EmailStyle>(saved.emailStyle ?? defaultEmailStyle)
  const emailStyleRef = useRef(emailStyle)
  emailStyleRef.current = emailStyle

  // Persist to disk (Electron only) whenever the saved state changes.
  useEffect(() => {
    persist({ version: 1, prospects, folders, campaigns, voices, campaignId, selectedId, onboarded, emailStyle, snippets })
  }, [prospects, folders, campaigns, voices, campaignId, selectedId, onboarded, emailStyle, snippets])
  const [tab, setTab] = useState<Tab>('chat')
  // Most of the time you're working through what needs review.
  const [filter, setFilter] = useState<Filter>('review')
  // The campaign switcher (⌘O) and the History menu (⌘⇧H).
  const [switcherOpen, setSwitcherOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  // The "Mark as sent" popover under the email.
  const [markSentOpen, setMarkSentOpen] = useState(false)
  const [showDiff, setShowDiff] = useState(false)
  // What's typed on the Add page, kept while you look elsewhere.
  const [addText, setAddText] = useState('')
  // Typing a list, or "Find with AI"; and the search being written.
  const [addMode, setAddMode] = useState<'list' | 'find'>('list')
  const [findText, setFindText] = useState('')
  const openAdd = () => setView('add')
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null)
  // Mailbox & API key settings (secrets stay in the main process).
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const openSettings = (page: SettingsPage = settingsPage) => {
    setSettingsPage(page)
    setView('settings')
  }
  const closeSettings = () => setView('email')
  useEffect(() => {
    window.api?.settings.get().then(setSettings)
  }, [])

  // Layout. The left sidebar (shadcn Sidebar) collapses to icons on narrower
  // screens and becomes a sheet on phones. The brief/chat panel docks in a
  // resizable group on wide screens and slides over as a sheet otherwise.
  const bp = useBreakpoint()
  const rightDocks = bp === 'wide'
  const [leftOpen, setLeftOpen] = useState(bp === 'wide' || bp === 'medium')
  const [rightOpen, setRightOpen] = useState(rightDocks)
  useEffect(() => {
    setLeftOpen(bp === 'wide' || bp === 'medium')
    setRightOpen(bp === 'wide')
  }, [bp])
  const rightPanelRef = usePanelRef()
  // Keep the docked panel in step with rightOpen (toggled by buttons and keys).
  useEffect(() => {
    const panel = rightPanelRef.current
    if (!rightDocks || !panel) return
    if (rightOpen && panel.isCollapsed()) panel.expand()
    if (!rightOpen && !panel.isCollapsed()) panel.collapse()
  }, [rightOpen, rightDocks, rightPanelRef])

  // Soft delete: anything with deletedAt is hidden everywhere except Deleted items.
  // A campaign in a deleted folder is hidden along with it.
  const aliveFolders = folders.filter((f) => !f.deletedAt)
  const aliveCampaigns = campaigns.filter((c) => !c.deletedAt && aliveFolders.some((f) => f.id === c.folderId))
  const aliveVoices = voices.filter((v) => !v.deletedAt)
  // If the open campaign was deleted, fall back to the first one left.
  const campaign = aliveCampaigns.find((c) => c.id === campaignId) ?? aliveCampaigns[0]
  const inCampaign = prospects.filter((p) => p.campaignId === campaign.id && !p.deletedAt)
  // Undefined when the campaign is empty (e.g. just created).
  const selected = inCampaign.find((p) => p.id === selectedId)
  const shown = inCampaign.filter(inFilter[filter])
  const update = (id: string, fn: (p: Prospect) => Prospect) => setProspects((ps) => ps.map((p) => (p.id === id ? fn(p) : p)))
  // The side column is an overlay (a sheet) only on narrower windows, and only while it's showing.
  const sheetOpen = !rightDocks && rightOpen && !!selected && view === 'email'
  // Only open while there's an unsent email on screen to mark; sending or switching away closes it.
  const markSentShown = markSentOpen && view === 'email' && !!selected && hasEmail(selected) && selected.status !== 'sent'
  useEffect(() => {
    if (markSentOpen && !markSentShown) setMarkSentOpen(false)
  }, [markSentOpen, markSentShown])
  const overlayOpen = palette || help || switcherOpen || historyOpen || markSentShown || sheetOpen
  // Latest state for callbacks that run later (timers, undo closures).
  const prospectsRef = useRef(prospects)
  prospectsRef.current = prospects
  const get = (id: string) => prospectsRef.current.find((p) => p.id === id)

  useLayoutEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    try {
      localStorage.setItem('theme', theme)
    } catch {
      // Storage can be unavailable (private mode); theme just won't persist.
    }
  }, [theme])

  // ---- Claude ----
  // Latest campaigns/voices/settings for async work that finishes later.
  const campaignsRef = useRef(campaigns)
  campaignsRef.current = campaigns
  const voicesRef = useRef(voices)
  voicesRef.current = voices
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const foldersRef = useRef(folders)
  foldersRef.current = folders

  // Streamed progress (research steps, chat text) is routed to whoever started the job.
  const jobs = useRef(new Map<string, (e: ClaudeProgress) => void>())
  useEffect(() => window.api?.claude.onProgress((e) => jobs.current.get(e.jobId)?.(e)), [])

  const voiceOf = (campaignId: string): Voice => {
    const vs = voicesRef.current.filter((v) => !v.deletedAt)
    const c = campaignsRef.current.find((c) => c.id === campaignId)
    return vs.find((v) => v.id === c?.voiceId) ?? vs[0]
  }
  const voiceInput = (v: Voice): VoiceInput => {
    const alive = (v.examples ?? []).filter((e) => !e.deletedAt)
    const pasted = alive.filter((e) => !e.draft)
    const learned = alive.filter((e) => e.draft).slice(-MAX_VOICE_EXAMPLES)
    return {
      name: v.name,
      notes: v.notes.filter((n) => !n.deletedAt).map((n) => n.text),
      examples: [...pasted, ...learned].map(({ draft, final }) => ({ draft, final })),
    }
  }
  const campaignNotes = (campaignId: string) => {
    const c = campaignsRef.current.find((c) => c.id === campaignId)
    // Claude should know what's attached so the email can mention it.
    const files = c?.attachments.length ? `\n\nAttached to every email: ${c.attachments.map((a) => a.name).join(', ')}` : ''
    // The folder's shared context comes first, then this campaign's own notes.
    const f = foldersRef.current.find((f) => f.id === c?.folderId)
    const about = f && (f.name || f.notes) ? `About ${f.name || 'the event'} (shared by every campaign in it):\n${f.notes}\n\nThis campaign:\n` : ''
    return about + (c?.notes ?? '') + files
  }
  const claudeContext = (p: Prospect) => {
    const c = campaignsRef.current.find((c) => c.id === p.campaignId)
    return {
      company: p.company,
      campaignNotes: campaignNotes(p.campaignId),
      emailFormat: c?.format,
      orgNote: p.note,
      voice: voiceInput(voiceOf(p.campaignId)),
      senderName: settingsRef.current?.mail?.fromName ?? '',
    }
  }

  // Running requests the user can stop, by prospect: research, and chat replies.
  const researchJobs = useRef(new Map<string, string>())
  // Chat replies are keyed by chat thread, since each thread can have its own reply running.
  const chatJobs = useRef(new Map<string, string>())
  const stopJob = (jobs: Map<string, string>, pid: string) => {
    const jobId = jobs.get(pid)
    if (jobId) void window.api?.claude.cancel(jobId)
  }

  // Research runner: pulls from the queue so at most MAX_CONCURRENT run at once.
  const researching = useRef(new Set<string>())
  // Research stopped because adding the organisation was undone. If it's
  // redone before the stop lands, it goes back in the queue instead of failing.
  const dropped = useRef(new Set<string>())
  const research = async (p: Prospect) => {
    const pid = p.id
    researching.current.add(pid)
    update(pid, (q) => ({ ...q, status: 'researching', progress: [], error: undefined }))
    const jobId = crypto.randomUUID()
    researchJobs.current.set(pid, jobId)
    jobs.current.set(jobId, (e) => e.kind === 'step' && update(pid, (q) => ({ ...q, progress: [...q.progress, e.text] })))
    const researchOnly = !!campaignsRef.current.find((c) => c.id === p.campaignId)?.researchOnly
    const res = window.api
      ? await window.api.claude.research({ jobId, website: p.domain || undefined, ...claudeContext(p), discovery: p.discovery, draft: !researchOnly })
      : ({ ok: false, error: 'Research runs in the Inroad desktop app.' } as const)
    jobs.current.delete(jobId)
    researchJobs.current.delete(pid)
    researching.current.delete(pid)
    if (dropped.current.delete(pid)) return update(pid, (q) => ({ ...q, status: 'queued', progress: [] }))
    if (!res.ok) return update(pid, (q) => ({ ...q, status: 'failed', error: res.error === 'Stopped.' ? 'You stopped the research.' : res.error }))
    const { research, brief, draft } = res.value
    if (!draft) return update(pid, (q) => ({ ...q, status: 'researched', research, brief }))
    const md = normalizeMarkdown(draft.body)
    update(pid, (q) => ({
      ...q,
      status: 'drafted',
      research,
      brief,
      subject: draft.subject,
      body: md,
      originalBody: md,
      to: draft.to ? [draft.to] : [],
      versions: [...q.versions, { id: crypto.randomUUID(), label: 'AI draft', by: 'claude', at: Date.now(), markdown: md }],
      comments: [...(q.comments ?? []), ...stamp(draft.comments, 'draft')],
    }))
  }
  useEffect(() => {
    let free = MAX_CONCURRENT - researching.current.size
    for (const p of prospects) {
      if (free <= 0) break
      if (p.status !== 'queued' || p.deletedAt || researching.current.has(p.id)) continue
      free--
      void research(p)
    }
  })

  // One toast at a time (same id), with Undo / Redo where it applies.
  const undoRef = useRef<() => void>(() => {})
  const redoRef = useRef<() => void>(() => {})
  const notify = (t: Toast) =>
    toast(t.text, {
      id: 'app',
      duration: UNDO_GRACE_MS,
      action: t.undo
        ? { label: 'Undo', onClick: () => undoRef.current() }
        : t.redo
          ? { label: 'Redo', onClick: () => redoRef.current() }
          : t.action
            ? { label: t.action.label, onClick: t.action.run }
            : undefined,
    })

  const select = (id: string) => {
    setView('email')
    setSelectedId(id)
    setShowDiff(false)
  }

  const step = (delta: number) => {
    if (!shown.length) return
    const i = shown.findIndex((p) => p.id === selectedId)
    if (i >= 0) return select(shown[Math.min(Math.max(i + delta, 0), shown.length - 1)].id)
    // The open one isn't in this list (just archived, say): step from where it sits in the campaign.
    const at = inCampaign.findIndex((p) => p.id === selectedId)
    const before = shown.filter((p) => inCampaign.indexOf(p) < at)
    const after = shown.filter((p) => inCampaign.indexOf(p) > at)
    select((delta > 0 ? (after[0] ?? before.at(-1)) : (before.at(-1) ?? after[0]))!.id)
  }

  // Next prospect after the current one (wrapping) that still needs review.
  const nextReviewId = (fromId: string, ps = inCampaign) => {
    const i = ps.findIndex((p) => p.id === fromId)
    const ordered = [...ps.slice(i + 1), ...ps.slice(0, i)]
    return ordered.find(needsReview)?.id
  }

  const focusLater = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus())

  // ---- Undo (see undo.ts for how this shares ⌘Z with the editor) ----
  const undoStack = useRef<UndoEntry[]>([])
  const redoStack = useRef<UndoEntry[]>([])
  // A plain text box typed in since the last app action keeps its native ⌘Z.
  const dirtyInput = useRef<EventTarget | null>(null)
  useEffect(() => {
    const onInput = (e: Event) => {
      const t = e.target as HTMLElement
      if (!t.closest?.('#email-body')) dirtyInput.current = t
    }
    document.addEventListener('input', onInput)
    return () => document.removeEventListener('input', onInput)
  }, [])

  const editorMark = () => {
    const editor = currentEditor()
    return { editor, editorDepth: editor ? historyDepth(editor.state) : 0 }
  }

  const record = (label: string, prospectId: string | undefined, undo: UndoEntry['undo'], redo: UndoEntry['redo'], toastText = label) => {
    undoStack.current.push({ label, prospectId, ...editorMark(), undo, redo })
    redoStack.current = []
    dirtyInput.current = null
    notify({ text: toastText, undo: true })
  }

  const goTo = (id?: string) => {
    const p = id && get(id)
    if (!p) return
    if (p.campaignId !== campaignId) setCampaignId(p.campaignId)
    if (p.id !== selectedId) select(p.id)
  }

  const appUndo = () => {
    const entry = undoStack.current.pop()
    if (!entry) return notify({ text: 'Nothing to undo' })
    goTo(entry.prospectId)
    const note = entry.undo()
    redoStack.current.push(entry)
    dirtyInput.current = null
    notify({ text: note || `Undid: ${entry.label}`, redo: true })
  }

  const appRedo = () => {
    const entry = redoStack.current.pop()
    if (!entry) return notify({ text: 'Nothing to redo' })
    goTo(entry.prospectId)
    entry.redo()
    undoStack.current.push({ ...entry, ...editorMark() })
    dirtyInput.current = null
    notify({ text: `Redid: ${entry.label}`, undo: true })
  }

  // The editor asks before handling ⌘Z: if the newest app action is more
  // recent than the typing in this editor, the app undoes that instead.
  undoRef.current = appUndo
  redoRef.current = appRedo
  undoBridge.undo = (editor, depth) => {
    const top = undoStack.current.at(-1)
    if (!top) return false
    const appIsNewer = top.editor === editor ? depth <= top.editorDepth : depth === 0
    if (!appIsNewer) return false
    appUndo()
    return true
  }
  undoBridge.redo = (depth) => {
    if (depth > 0 || !redoStack.current.length) return false
    appRedo()
    return true
  }

  const switchCampaign = (id: string) => {
    setCampaignId(id)
    const list = prospects.filter((p) => p.campaignId === id && !p.deletedAt)
    const first = list.find(needsReview) ?? list.find((p) => !p.archivedAt) ?? list[0]
    if (first) select(first.id)
  }

  const updateCampaign = (id: string, patch: Partial<Campaign>) => setCampaigns((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))

  // New campaigns go in the open campaign's folder unless told otherwise.
  const createCampaign = (folderId = campaign.folderId) => {
    const id = crypto.randomUUID()
    setCampaigns((cs) => [...cs, { id, folderId, name: '', notes: '', attachments: [], voiceId: campaign.voiceId, researchOnly: true }])
    setCampaignId(id)
    setView('email')
    return id
  }

  // ---- Folders: shared context for the campaigns inside ----
  const folder = aliveFolders.find((f) => f.id === campaign.folderId) ?? aliveFolders[0]
  const updateFolder = (id: string, patch: Partial<Folder>) => setFolders((fs) => fs.map((f) => (f.id === id ? { ...f, ...patch } : f)))

  // A folder always starts with one campaign, so there's somewhere to add organisations.
  const createFolder = () => {
    const f: Folder = { id: crypto.randomUUID(), name: '', notes: '' }
    setFolders((fs) => [...fs, f])
    createCampaign(f.id)
    return f.id
  }

  // A deleted voice falls back to the first one left; restoring it brings it back.
  const voice = aliveVoices.find((v) => v.id === campaign.voiceId) ?? aliveVoices[0]
  const editVoices = () => openSettings({ kind: 'voice', id: voice.id })

  const setVoice = (voiceId: string) => {
    const cid = campaignId
    const prev = campaign.voiceId
    if (voiceId === prev) return
    const name = voices.find((v) => v.id === voiceId)?.name ?? voiceId
    updateCampaign(cid, { voiceId })
    record(
      `Writing as ${name}`,
      undefined,
      () => updateCampaign(cid, { voiceId: prev }),
      () => updateCampaign(cid, { voiceId }),
      `${campaign.name || 'This campaign'} now writes as ${name}. Regenerate a draft to apply it.`,
    )
  }

  // ---- Soft delete. Everything goes to Deleted items and can be undone. ----
  const setProspectDeleted = (id: string, at?: number) => update(id, (p) => ({ ...p, deletedAt: at }))
  const setCampaignDeleted = (id: string, at?: number) => setCampaigns((cs) => cs.map((c) => (c.id === id ? { ...c, deletedAt: at } : c)))
  const setVoiceDeleted = (id: string, at?: number) => setVoices((vs) => vs.map((v) => (v.id === id ? { ...v, deletedAt: at } : v)))
  const setNoteDeleted = (voiceId: string, text: string, at?: number) =>
    setVoices((vs) => vs.map((v) => (v.id !== voiceId ? v : { ...v, notes: v.notes.map((n) => (n.text === text ? { ...n, deletedAt: at } : n)) })))
  const setChatDeleted = (pid: string, chatId: string, at?: number) =>
    update(pid, (p) => ({ ...p, chats: p.chats.map((c) => (c.id === chatId ? { ...c, deletedAt: at } : c)) }))
  const setVersionDeleted = (pid: string, versionId: string, at?: number) =>
    update(pid, (p) => ({ ...p, versions: p.versions.map((v) => (v.id === versionId ? { ...v, deletedAt: at } : v)) }))

  // Records a soft delete on the undo stack, with a toast pointing at Deleted items.
  const softDelete = (label: string, set: (at?: number) => void, prospectId?: string, afterUndo?: () => void) => {
    const at = Date.now()
    set(at)
    record(
      `Deleted ${label}`,
      prospectId,
      () => {
        set(undefined)
        afterUndo?.()
      },
      () => set(at),
      `Moved ${label} to Deleted items`,
    )
  }

  const deleteProspect = (id: string) => {
    const p = get(id)
    if (!p) return
    if (id === selectedId) {
      const i = inCampaign.findIndex((x) => x.id === id)
      const rest = inCampaign.filter((x) => x.id !== id)
      const next = rest[Math.min(i, rest.length - 1)]
      if (next) select(next.id)
    }
    softDelete(
      p.company,
      (at) => setProspectDeleted(id, at),
      undefined,
      () => select(id),
    )
  }

  const setFolderDeleted = (id: string, at?: number) => setFolders((fs) => fs.map((f) => (f.id === id ? { ...f, deletedAt: at } : f)))

  const deleteFolder = (id: string) => {
    const f = folders.find((x) => x.id === id)
    if (!f || aliveFolders.length < 2) return notify({ text: 'You need at least one folder' })
    if (settingsPage.kind === 'folder' && settingsPage.id === id) setSettingsPage({ kind: 'mailbox' })
    const other = aliveCampaigns.find((c) => c.folderId !== id)
    if (campaign.folderId === id) {
      if (other) switchCampaign(other.id)
      else createCampaign(aliveFolders.find((x) => x.id !== id)!.id)
    }
    softDelete(
      f.name || 'Untitled folder',
      (at) => setFolderDeleted(id, at),
      undefined,
      () => setCampaignId(campaigns.find((c) => c.folderId === id && !c.deletedAt)?.id ?? campaignId),
    )
  }

  const deleteCampaign = (id: string) => {
    const c = campaigns.find((x) => x.id === id)
    if (!c || aliveCampaigns.length < 2) return notify({ text: 'You need at least one campaign' })
    const other = aliveCampaigns.find((x) => x.id !== id)!
    if (id === campaign.id) switchCampaign(other.id)
    softDelete(
      c.name || 'Untitled campaign',
      (at) => setCampaignDeleted(id, at),
      undefined,
      () => switchCampaign(id),
    )
  }

  const deleteVoice = (id: string) => {
    const v = voices.find((x) => x.id === id)
    if (!v || aliveVoices.length < 2) return notify({ text: 'You need at least one voice' })
    if (settingsPage.kind === 'voice' && settingsPage.id === id) setSettingsPage({ kind: 'voice', id: aliveVoices.find((x) => x.id !== id)!.id })
    softDelete(`the ${v.name} voice`, (at) => setVoiceDeleted(id, at))
  }

  const deleteVoiceNote = (voiceId: string, text: string) => softDelete('a style note', (at) => setNoteDeleted(voiceId, text, at))

  const updateVoice = (id: string, patch: Partial<Voice>) => setVoices((vs) => vs.map((v) => (v.id === id ? { ...v, ...patch } : v)))

  const createVoice = () => {
    const v: Voice = { id: crypto.randomUUID(), name: '', description: '', notes: [], examples: [] }
    const apply = () => setVoices((vs) => [...vs.filter((x) => x.id !== v.id), v])
    apply()
    record('Created a voice', undefined, () => setVoices((vs) => vs.filter((x) => x.id !== v.id)), apply)
    return v.id
  }

  const addVoiceNote = (voiceId: string, text: string) => {
    const note = { text, fresh: false }
    const apply = () => setVoices((vs) => vs.map((v) => (v.id === voiceId ? { ...v, notes: [...v.notes, note] } : v)))
    apply()
    record(
      'Added a style note',
      undefined,
      () => setVoices((vs) => vs.map((v) => (v.id === voiceId ? { ...v, notes: v.notes.filter((n) => n !== note) } : v))),
      apply,
    )
  }

  const setExampleDeleted = (voiceId: string, exampleId: string, at?: number) =>
    setVoices((vs) => vs.map((v) => (v.id !== voiceId ? v : { ...v, examples: v.examples?.map((e) => (e.id === exampleId ? { ...e, deletedAt: at } : e)) })))

  const addExample = (voiceId: string, final: string) => {
    const example: VoiceExample = { id: crypto.randomUUID(), at: Date.now(), final }
    const apply = () => setVoices((vs) => vs.map((v) => (v.id === voiceId ? { ...v, examples: [...(v.examples ?? []), example] } : v)))
    apply()
    record(
      'Added an example email',
      undefined,
      () => setVoices((vs) => vs.map((v) => (v.id === voiceId ? { ...v, examples: v.examples?.filter((e) => e.id !== example.id) } : v))),
      apply,
    )
  }

  const deleteExample = (voiceId: string, exampleId: string) => softDelete('an example email', (at) => setExampleDeleted(voiceId, exampleId, at))

  const setAttachments = (campaignId: string, fn: (a: Attachment[]) => Attachment[]) =>
    setCampaigns((cs) => cs.map((c) => (c.id === campaignId ? { ...c, attachments: fn(c.attachments) } : c)))

  const attachFiles = async (campaignId: string) => {
    const files = await window.api?.files.pickAttachments()
    if (!files?.length) return
    const ids = files.map((f) => f.id)
    const apply = () => setAttachments(campaignId, (as) => [...as.filter((a) => !ids.includes(a.id)), ...files])
    apply()
    record(
      `Attached ${files.length === 1 ? files[0].name : `${files.length} files`}`,
      undefined,
      () => setAttachments(campaignId, (as) => as.filter((a) => !ids.includes(a.id))),
      apply,
    )
  }

  const removeAttachment = (campaignId: string, id: string) => {
    const c = campaigns.find((x) => x.id === campaignId)
    const i = c?.attachments.findIndex((a) => a.id === id) ?? -1
    if (!c || i < 0) return
    const file = c.attachments[i]
    const apply = () => setAttachments(campaignId, (as) => as.filter((a) => a.id !== id))
    apply()
    record(`Removed ${file.name}`, undefined, () => setAttachments(campaignId, (as) => [...as.slice(0, i), file, ...as.slice(i)]), apply)
  }

  // ---- Snippets: reusable text, inserted in the email by typing "/" ----
  const setSnippetDeleted = (id: string, at?: number) => setSnippets((ss) => ss.map((s) => (s.id === id ? { ...s, deletedAt: at } : s)))
  const updateSnippet = (id: string, patch: Partial<Snippet>) => setSnippets((ss) => ss.map((s) => (s.id === id ? { ...s, ...patch } : s)))

  const addSnippet = (snippet: Omit<Snippet, 'id'>, toast?: string) => {
    const s: Snippet = { id: crypto.randomUUID(), ...snippet }
    const apply = () => setSnippets((ss) => [...ss.filter((x) => x.id !== s.id), s])
    apply()
    record(s.name ? `Saved the “${s.name}” snippet` : 'Created a snippet', undefined, () => setSnippets((ss) => ss.filter((x) => x.id !== s.id)), apply, toast)
    return s.id
  }

  const deleteSnippet = (id: string) => {
    const s = snippets.find((x) => x.id === id)
    if (s) softDelete(`the “${s.name || 'Untitled'}” snippet`, (at) => setSnippetDeleted(id, at))
  }

  const scopeLabel = (scope: Snippet['scope']) =>
    scope.kind === 'global'
      ? 'Everywhere'
      : scope.kind === 'folder'
        ? folders.find((f) => f.id === scope.id)?.name || 'Untitled folder'
        : campaigns.find((c) => c.id === scope.id)?.name || 'Untitled campaign'

  const deleteVersion = (v: Version) => {
    if (!selected) return
    const pid = selected.id
    softDelete(`“${v.label}”`, (at) => setVersionDeleted(pid, v.id, at), pid)
  }

  // ---- Chats: several per email ----
  const selectChat = (chatId: string) => selected && update(selected.id, (p) => ({ ...p, activeChatId: chatId }))

  const newChat = () => {
    if (!selected || !hasEmail(selected)) return
    const thread: ChatThread = { id: crypto.randomUUID(), title: 'New chat', createdAt: Date.now(), messages: [] }
    update(selected.id, (p) => ({ ...p, chats: [...p.chats, thread], activeChatId: thread.id }))
    setTab('chat')
    setRightOpen(true)
    focusLater('chat-input')
  }

  const deleteChat = (chatId: string) => {
    if (!selected) return
    const pid = selected.id
    const thread = selected.chats.find((c) => c.id === chatId)
    if (!thread) return
    softDelete(`the “${thread.title}” chat`, (at) => setChatDeleted(pid, chatId, at), pid)
  }

  const commitTimers = useRef<Record<string, number>>({})
  // Each prospect's trips to the mailbox, one after another, so a save always
  // replaces the draft the one before it left.
  const commitQueue = useRef<Record<string, Promise<void>>>({})
  // Saves not yet recorded (in their undo window, or on their way to the mailbox), by
  // prospect: the status before, and how to call the save off. The sent check
  // leaves these alone, and marking one sent calls its save off.
  const pendingSaves = useRef(new Map<string, { status: Status; cancel: () => void }>())

  // ---- Voice learning: what a save taught Claude about how you write ----
  const applyVoiceChange = (c: VoiceChange, on: boolean) =>
    setVoices((vs) =>
      vs.map((v) => {
        if (v.id !== c.voiceId) return v
        const examples = v.examples ?? []
        if (!on)
          return {
            ...v,
            notes: v.notes.filter((n) => !(n.fresh && c.add.includes(n.text))).map((n) => (n.deletedAt === c.at ? { ...n, deletedAt: undefined } : n)),
            examples: examples.filter((e) => e.id !== c.example.id),
          }
        return {
          ...v,
          // Contradicted notes go to Deleted items rather than vanishing.
          notes: [
            ...v.notes.map((n) => (!n.deletedAt && c.remove.includes(n.text) ? { ...n, deletedAt: c.at } : n)),
            ...c.add.map((text) => ({ text, fresh: true })),
          ],
          examples: [...examples, c.example],
        }
      }),
    )

  // Compares Claude's draft with what you saved. The pair itself is kept as an
  // example even if extracting notes fails.
  const learnVoice = async (p: Prospect): Promise<VoiceChange> => {
    const v = voiceOf(p.campaignId)
    const example: VoiceExample = { id: crypto.randomUUID(), at: Date.now(), draft: p.originalBody, final: p.body }
    const base: VoiceChange = { voiceId: v.id, at: Date.now(), add: [], remove: [], example }
    if (!window.api) return base
    const res = await window.api.claude.learnVoice({ voiceName: v.name, notes: voiceInput(v).notes, draft: example.draft!, final: example.final })
    return res.ok ? { ...base, ...res.value } : base
  }

  const mailReady = !!settings?.mail && !!settings.hasMailPassword

  const save = () => {
    if (!selected || !hasEmail(selected)) return
    // Another draft would only invite sending it twice.
    if (selected.status === 'sent') return notify({ text: `${selected.company}'s email was already sent, so there's nothing to save` })
    if (!selected.body.trim()) return notify({ text: 'Write the email first, or press ⌘R to have the AI draft it' })
    if (!mailReady)
      return notify({ text: 'Connect your mailbox to save drafts', action: { label: 'Open settings', run: () => openSettings({ kind: 'mailbox' }) } })
    const { id: pid, status: prev, company } = selected
    // Only edits to an AI draft teach the voice; an email written from scratch has nothing to compare.
    const edited = !!selected.originalBody && selected.body !== selected.originalBody
    const versionId = crypto.randomUUID()
    // This save's trip to the mailbox, so undo knows whether to cancel it or delete the draft.
    // attempt is the current go at it: undo (or marking sent) clears it, and a
    // commit that lands after that removes its own draft instead of recording it.
    const sync: { committed: boolean; failed?: boolean; ref?: DraftRef; attempt?: object } = { committed: false }
    const pending = {
      status: prev,
      cancel: () => {
        clearTimeout(commitTimers.current[pid])
        sync.attempt = undefined
        if (pendingSaves.current.get(pid) === pending) pendingSaves.current.delete(pid)
      },
    }
    // Voice learning runs alongside; undo rolls it back, redo re-applies it.
    const learn: { started: boolean; active: boolean; change?: VoiceChange } = { started: false, active: false }
    const snapshot = selected

    // Past the undo window: queue behind any earlier save of this email still on its way.
    const commitLater = () => {
      sync.committed = true
      const attempt = sync.attempt
      const go = () => commit(attempt).then(() => {})
      commitQueue.current[pid] = (commitQueue.current[pid] ?? Promise.resolve()).then(go, go)
    }

    const commit = async (attempt: object | undefined) => {
      // Only the go at it that's still current clears the entry; a redo or newer save owns it otherwise.
      const settle = () => sync.attempt === attempt && pendingSaves.current.get(pid) === pending && pendingSaves.current.delete(pid)
      const p = get(pid)
      // Undone, marked as sent or gone while it waited: nothing to save.
      if (sync.attempt !== attempt || !p || !window.api || p.status === 'sent') return void settle()
      // The draft this one replaces: whatever's recorded now, which can be a
      // save that landed after this one was made.
      const replaced = p.draftRef
      const attachments = campaignsRef.current.find((c) => c.id === p.campaignId)?.attachments ?? []
      const res = await window.api.mail.saveDraft({
        to: p.to,
        subject: p.subject,
        html: emailHtml(p.body, emailStyleRef.current),
        text: markdownToText(p.body),
        attachments,
      })
      // Until the new draft is recorded, the sent check would be looking at the old one.
      settle()
      // Undone or marked sent on the way: take the draft back out.
      if (sync.attempt !== attempt) {
        if (res.ok) void window.api.mail.deleteDraft(res.value)
        return
      }
      if (!res.ok) {
        sync.failed = true
        // A newer save on its way still counts as saved.
        const newer = pendingSaves.current.has(pid)
        update(pid, (q) => ({
          ...q,
          status: q.status === 'sent' || newer ? q.status : prev === 'saved' ? 'edited' : prev,
          versions: q.versions.filter((v) => v.id !== versionId),
        }))
        return notify({
          text: `Couldn’t save ${company} to Drafts: ${res.error}`,
          action: { label: 'Open settings', run: () => openSettings({ kind: 'mailbox' }) },
        })
      }
      sync.ref = res.value
      update(pid, (q) => ({ ...q, status: q.status === 'sent' ? 'sent' : 'saved', draftRef: res.value, draftMissing: undefined }))
      // Saving again replaces the earlier draft rather than leaving a duplicate behind.
      if (replaced) void window.api.mail.deleteDraft(replaced)
    }

    const apply = () => {
      update(pid, (p) => ({
        ...p,
        status: 'saved',
        versions: [...p.versions, { id: versionId, label: 'Saved to Drafts', by: 'you', at: Date.now(), markdown: p.body }],
      }))
      // Held back briefly so undo can cancel it before anything reaches the mailbox.
      sync.committed = false
      sync.failed = undefined
      sync.ref = undefined
      sync.attempt = {}
      pendingSaves.current.set(pid, pending)
      clearTimeout(commitTimers.current[pid])
      commitTimers.current[pid] = window.setTimeout(commitLater, UNDO_GRACE_MS)
      if (!edited) return
      learn.active = true
      if (learn.change) return applyVoiceChange(learn.change, true)
      if (learn.started) return
      learn.started = true
      void learnVoice(snapshot).then((change) => {
        learn.change = change
        if (!learn.active) return
        applyVoiceChange(change, true)
        const v = voicesRef.current.find((x) => x.id === change.voiceId)
        const n = change.add.length + change.remove.length
        if (n && v)
          notify({
            text: `Updated ${v.name}: ${[change.add.length && `${change.add.length} new note${change.add.length > 1 ? 's' : ''}`, change.remove.length && `${change.remove.length} removed`].filter(Boolean).join(', ')}`,
            action: { label: 'View', run: () => openSettings({ kind: 'voice', id: v.id }) },
          })
      })
    }
    apply()
    const next = nextReviewId(pid)
    if (next) select(next)
    const nextName = next && get(next)?.company
    record(
      'Saved to Drafts',
      pid,
      () => {
        // It went out since: there's no draft left to take back.
        if (get(pid)?.status === 'sent') return `${company}'s email has been sent since, so there's no draft to remove`
        // Once the save reached the mailbox it replaced (deleted) the earlier
        // draft, so don't point at that one. Short of that, it's as it was.
        const landed = !!sync.ref
        update(pid, (p) => ({
          ...p,
          status: landed && prev === 'saved' ? statusAfter({ ...p, status: 'edited' }, p.body) : prev,
          // A save that never landed never changed it.
          draftRef: landed ? undefined : p.draftRef,
          versions: p.versions.filter((v) => v.id !== versionId),
        }))
        learn.active = false
        if (learn.change) applyVoiceChange(learn.change, false)
        if (!landed) {
          const onItsWay = sync.committed && !sync.failed
          pending.cancel()
          return onItsWay ? `Cancelled saving ${company}` : `Cancelled saving ${company}. Nothing reached your mailbox.`
        }
        if (window.api && sync.ref)
          void window.api.mail.deleteDraft(sync.ref).then((r) => !r.ok && notify({ text: `Couldn’t remove the draft from your mailbox: ${r.error}` }))
        return `Deleted ${company}'s draft from your mailbox${learn.change ? ' and rolled back the voice update' : ''}`
      },
      () => get(pid)?.status !== 'sent' && apply(),
      `Saved ${company} to Drafts${nextName ? ` · now on ${nextName}` : ''}`,
    )
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  // ---- Sent & archived ----
  // When an organisation drops out of the list being worked through, move on to its neighbour.
  const leaveList = (id: string, after: Prospect) => {
    if (id !== selectedId || inFilter[filter](after)) return
    const i = shown.findIndex((x) => x.id === id)
    const rest = shown.filter((x) => x.id !== id)
    const next = rest[Math.min(Math.max(i, 0), rest.length - 1)]
    if (next) select(next.id)
  }

  const toggleArchive = (id: string) => {
    const p = get(id)
    if (!p) return
    const prev = p.archivedAt
    const at = prev ? undefined : Date.now()
    const set = (archivedAt?: number) => update(id, (q) => ({ ...q, archivedAt }))
    leaveList(id, { ...p, archivedAt: at })
    set(at)
    record(at ? `Archived ${p.company}` : `Unarchived ${p.company}`, id, () => set(prev), () => set(at))
  }

  type SentFields = Pick<Prospect, 'status' | 'sentAt' | 'sentNote' | 'sentBy' | 'sentFrom' | 'archivedAt' | 'draftMissing' | 'draftRef'>
  const sentFields = (p: Prospect): SentFields => ({
    status: p.status,
    sentAt: p.sentAt,
    sentNote: p.sentNote,
    sentBy: p.sentBy,
    sentFrom: p.sentFrom,
    archivedAt: p.archivedAt,
    draftMissing: p.draftMissing,
    draftRef: p.draftRef,
  })
  const setSentFields = (id: string, f: SentFields) => update(id, (q) => ({ ...q, ...f }))
  // Undoing an edit puts back the old text, not an old status: an email
  // that's been sent since (spotted in the background) stays sent.
  const keepSent = (now: Prospect, next: Prospect): Prospect => (now.status === 'sent' ? { ...next, ...sentFields(now) } : next)

  // For emails sent some other way (a contact form, another mail app), or that Inroad didn't spot.
  const markSent = (id: string, note = '') => {
    const p = get(id)
    if (!p || !hasEmail(p)) return
    // A save still on its way would leave a draft of a sent email in the
    // mailbox: call it off, and undo goes back to before it.
    const saving = pendingSaves.current.get(id)
    saving?.cancel()
    const before = saving ? { ...sentFields(p), status: saving.status } : sentFields(p)
    const now = Date.now()
    const after: SentFields = {
      ...before,
      sentFrom: before.status,
      status: 'sent',
      sentAt: now,
      sentNote: note.trim() || undefined,
      sentBy: 'you',
      archivedAt: p.archivedAt ?? now,
      draftMissing: undefined,
    }
    leaveList(id, { ...p, ...after })
    setSentFields(id, after)
    record('Marked as sent', id, () => setSentFields(id, before), () => setSentFields(id, after), `Marked ${p.company} as sent · moved to Archived`)
  }

  // Inroad got it wrong, or you changed your mind. Marked by hand: back to how
  // it was, draft and all, and the next check sees to it. Spotted in Sent: the
  // draft has left Drafts, so forget it rather than spotting the same sent copy again.
  const markNotSent = (id: string) => {
    const p = get(id)
    if (!p || p.status !== 'sent') return
    const before = sentFields(p)
    const byHand = p.sentBy === 'you'
    const after: SentFields = {
      status: byHand && p.sentFrom ? p.sentFrom : statusAfter({ ...p, status: 'edited' }, p.body),
      sentAt: undefined,
      sentNote: undefined,
      sentBy: undefined,
      sentFrom: undefined,
      archivedAt: undefined,
      draftMissing: undefined,
      draftRef: byHand ? p.draftRef : undefined,
    }
    setSentFields(id, after)
    record('Marked as not sent', id, () => setSentFields(id, before), () => setSentFields(id, after), `Marked ${p.company} as not sent`)
  }

  // Saved drafts that left Drafts and turned up in Sent were sent from the
  // mail app: mark them sent and archive them. Runs quietly; a failed check just waits for the next.
  const checkingSent = useRef(false)
  const checkSent = async () => {
    if (!window.api || !mailReady || checkingSent.current) return
    // Drafts saved before Inroad recorded the time: the last "Saved to Drafts" version.
    const savedAt = (p: Prospect) => p.draftRef?.savedAt ?? [...p.versions].reverse().find((v) => v.label === 'Saved to Drafts')?.at ?? 0
    const checks: SentCheck[] = prospectsRef.current
      .filter((p) => p.status === 'saved' && p.draftRef && !p.deletedAt && !pendingSaves.current.has(p.id))
      .map((p) => ({ id: p.id, ref: p.draftRef!, to: p.to, savedAt: savedAt(p) }))
    if (!checks.length) return
    checkingSent.current = true
    const res = await window.api.mail.checkSent(checks).finally(() => (checkingSent.current = false))
    if (!res.ok) return
    const sent: string[] = []
    for (const c of checks) {
      const r = res.value[c.id]
      const p = get(c.id)
      // Skip anything saved again, or changed by hand, while the check ran.
      if (!r || !p || p.status !== 'saved' || p.draftRef?.messageId !== c.ref.messageId || pendingSaves.current.has(p.id)) continue
      if (r.state === 'sent') {
        update(p.id, (q) => ({ ...q, status: 'sent', sentAt: r.at, sentBy: 'check', archivedAt: q.archivedAt ?? Date.now(), draftMissing: undefined }))
        sent.push(p.company)
      } else if (!!p.draftMissing !== (r.state === 'missing')) update(p.id, (q) => ({ ...q, draftMissing: r.state === 'missing' || undefined }))
    }
    if (sent.length)
      notify({
        text: sent.length === 1 ? `${sent[0]}'s email was sent · moved to Archived` : `${sent.length} emails were sent · moved to Archived`,
        action: { label: 'Show', run: () => setFilter('archived') },
      })
  }
  const checkSentRef = useRef(checkSent)
  checkSentRef.current = checkSent
  useEffect(() => {
    if (!mailReady) return
    const run = () => void checkSentRef.current()
    run()
    const timer = window.setInterval(run, SENT_CHECK_MS)
    // Coming back from the mail app is when something's most likely just been sent.
    window.addEventListener('focus', run)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', run)
    }
  }, [mailReady])

  // For contact forms: plain text pastes into a form, HTML into a rich editor.
  const copyEmail = async (what: 'body' | 'subject' = 'body') => {
    if (!selected || !hasEmail(selected)) return
    const p = selected
    const failed = () => notify({ text: 'Couldn’t copy. Click into the window and try again.' })
    if (what === 'subject') {
      if (!p.subject.trim()) return notify({ text: 'There’s no subject yet' })
      return navigator.clipboard.writeText(p.subject).then(() => notify({ text: 'Copied the subject' }), failed)
    }
    if (!p.body.trim()) return notify({ text: 'Write the email first, or press ⌘R to have the AI draft it' })
    const text = markdownToText(p.body)
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([text], { type: 'text/plain' }),
          'text/html': new Blob([emailHtml(p.body, emailStyleRef.current)], { type: 'text/html' }),
        }),
      ])
    } catch {
      // Some setups refuse HTML on the clipboard; plain text is what a form needs anyway.
      const ok = await navigator.clipboard.writeText(text).then(() => true, () => false)
      if (!ok) return failed()
    }
    notify({
      text: p.status === 'sent' ? `Copied ${p.company}'s email` : `Copied ${p.company}'s email. Once it's sent, mark it as sent.`,
      action:
        p.status === 'sent'
          ? undefined
          : {
              label: 'Mark as sent',
              run: () => {
                goTo(p.id)
                setMarkSentOpen(true)
              },
            },
    })
  }

  // Research-only campaigns: write the email for one organisation from its research.
  const writeDraft = async () => {
    if (!selected || !hasEmail(selected) || selected.originalBody || regeneratingId || !window.api) return
    const p = selected
    const pid = p.id
    setRegeneratingId(pid)
    const res = await window.api.claude.draft({ ...claudeContext(p), research: p.research ?? JSON.stringify(p.brief ?? {}) })
    setRegeneratingId(null)
    if (!res.ok) return notify({ text: `Couldn’t write the draft: ${res.error}` })
    const md = normalizeMarkdown(res.value.body)
    const before = get(pid)
    if (!before) return
    const version: Version = { id: crypto.randomUUID(), label: 'AI draft', by: 'claude', at: Date.now(), markdown: md }
    // Anything you'd written yourself stays in History.
    const yours: Version[] = before.body.trim() ? [{ id: crypto.randomUUID(), label: 'Your edits', by: 'you', at: Date.now(), markdown: before.body }] : []
    const fresh = stamp(res.value.comments, 'draft')
    const apply = () =>
      update(pid, (q) => ({
        ...q,
        status: isDone(q.status) ? q.status : 'drafted',
        brief: res.value.brief,
        subject: res.value.subject,
        body: md,
        originalBody: md,
        to: q.to.length ? q.to : res.value.to ? [res.value.to] : [],
        versions: [...q.versions.filter((v) => v.id !== version.id && !yours.some((y) => y.id === v.id)), ...yours, version],
        comments: [...(q.comments ?? []).filter((c) => !fresh.some((f) => f.id === c.id)), ...fresh],
      }))
    apply()
    record(
      'Wrote draft',
      pid,
      () => update(pid, (q) => keepSent(q, { ...q, ...before, chats: q.chats })),
      apply,
      `Wrote a draft for ${p.company}`,
    )
  }

  const regenerate = async () => {
    if (selected && hasEmail(selected) && !selected.originalBody) return writeDraft()
    if (!selected?.originalBody || regeneratingId || !window.api) return
    const p = selected
    const pid = p.id
    // Drafts made before research notes were kept fall back to the brief.
    const research = p.research ?? (p.brief ? JSON.stringify(p.brief) : '')
    if (!research) return notify({ text: 'Nothing to redraft from yet. Retry the research first.' })
    setRegeneratingId(pid)
    const res = await window.api.claude.draft({ ...claudeContext(p), research, previousDraft: `Subject: ${p.subject}\n\n${p.body}` })
    setRegeneratingId(null)
    if (!res.ok) return notify({ text: `Couldn’t regenerate: ${res.error}` })
    const q = get(pid)
    if (!q) return
    const md = normalizeMarkdown(res.value.body)
    const subject = res.value.subject
    const before = { body: q.body, originalBody: q.originalBody, subject: q.subject, status: q.status, comments: q.comments }
    const fresh = stamp(res.value.comments, 'draft')
    // Keep your edits in history so regenerating never loses work.
    const added: Version[] = [
      ...(q.versions.some((v) => v.markdown === q.body)
        ? []
        : [{ id: crypto.randomUUID(), label: 'Your edits', by: 'you' as const, at: Date.now(), markdown: q.body }]),
      { id: crypto.randomUUID(), label: 'Regenerated draft', by: 'claude', at: Date.now(), markdown: md },
    ]
    const apply = () =>
      update(pid, (x) => ({
        ...x,
        body: md,
        originalBody: md,
        subject,
        status: isDone(x.status) ? x.status : 'drafted',
        versions: [...x.versions.filter((v) => !added.some((a) => a.id === v.id)), ...added],
        // The new draft's comments replace the old draft's; ones from chat stay.
        comments: [...(x.comments ?? []).filter((c) => c.by !== 'draft' && !fresh.some((f) => f.id === c.id)), ...fresh],
      }))
    apply()
    record(
      'Regenerated draft',
      pid,
      () => {
        update(pid, (x) => keepSent(x, { ...x, ...before }))
        return 'Back to your previous version. The regenerated one is still in History.'
      },
      apply,
      `Regenerated ${q.company} · your previous version is in History`,
    )
  }

  const restoreVersion = (v: Version) => {
    if (!selected) return
    const { id: pid, body: prevBody } = selected
    const setBody = (body: string) => update(pid, (p) => ({ ...p, body, status: statusAfter(p, body) }))
    if (!selected.versions.some((x) => x.markdown === prevBody))
      update(pid, (p) => ({ ...p, versions: [...p.versions, { id: crypto.randomUUID(), label: 'Your edits', by: 'you', at: Date.now(), markdown: prevBody }] }))
    setBody(v.markdown)
    record(
      `Restored “${v.label}”`,
      pid,
      () => setBody(prevBody),
      () => setBody(v.markdown),
    )
  }

  const findProposal = (p: Prospect, msgId: string, propId: string) =>
    p.chats
      .flatMap((c) => c.messages)
      .find((m) => m.id === msgId)
      ?.proposals?.find((x) => x.id === propId)

  const setProposalState = (pid: string, msgId: string, propId: string, state: 'pending' | 'accepted' | 'rejected') =>
    update(pid, (p) => ({
      ...p,
      chats: p.chats.map((c) => ({
        ...c,
        messages: c.messages.map((m) => (m.id !== msgId ? m : { ...m, proposals: m.proposals?.map((x) => (x.id === propId ? { ...x, state } : x)) })),
      })),
    }))

  // Suggestions quote plain text from either the subject or the body.
  const swapIn = (p: Prospect, from: string, to: string): Prospect => {
    if (p.subject.includes(from)) return { ...p, subject: p.subject.replace(from, () => to) }
    // Re-normalise so the stored text matches what the editor would write.
    const body = normalizeMarkdown(p.body.replace(from, () => to))
    return { ...p, body, status: statusAfter(p, body) }
  }
  const swapText = (pid: string, from: string, to: string) => update(pid, (p) => swapIn(p, from, to))

  const resolveProposal = (msgId: string, propId: string, accept: boolean) => {
    if (!selected) return
    const pid = selected.id
    const prop = findProposal(selected, msgId, propId)
    if (!prop) return
    if (accept && !hasText(selected, prop.old)) return notify({ text: 'Couldn’t apply: that text has changed since the AI suggested it' })
    const apply = () => {
      if (accept) swapText(pid, prop.old, prop.new)
      setProposalState(pid, msgId, propId, accept ? 'accepted' : 'rejected')
    }
    apply()
    record(
      accept ? 'Accepted suggestion' : 'Rejected suggestion',
      pid,
      () => {
        setProposalState(pid, msgId, propId, 'pending')
        if (!accept) return
        // Swap just that text back, so anything typed since survives.
        if (!hasText(get(pid), prop.new)) return 'Suggestion is back, but you’ve edited that text since, so the email was left as is'
        swapText(pid, prop.new, prop.old)
      },
      apply,
    )
  }

  const resolveNextProposal = (accept: boolean) => {
    if (!selected) return
    for (const m of activeChat(selected)?.messages ?? [])
      for (const pr of m.proposals ?? [])
        if (pr.state === 'pending') return resolveProposal(m.id, pr.id, accept)
  }

  // Accept all / Reject all on one reply's suggestions, as a single undo step.
  // Suggestions are applied one after another, each checked against the email
  // as the earlier ones left it; any whose text is gone by then stay pending.
  const resolveAllProposals = (msgId: string, accept: boolean) => {
    const start = selected && get(selected.id)
    if (!start) return
    const pid = start.id
    const msg = start.chats.flatMap((c) => c.messages).find((m) => m.id === msgId)
    const pending = (msg?.proposals ?? []).filter((x) => x.state === 'pending')
    let after = start
    const done = pending.filter((x) => {
      if (!accept) return true
      if (!hasText(after, x.old)) return false
      after = swapIn(after, x.old, x.new)
      return true
    })
    if (!done.length) return notify({ text: 'Couldn’t apply: that text has changed since the AI suggested it' })
    const state = accept ? 'accepted' : 'rejected'
    const email = { subject: after.subject, body: after.body, status: after.status }
    const apply = () => {
      if (accept) update(pid, (p) => keepSent(p, { ...p, ...email }))
      done.forEach((x) => setProposalState(pid, msgId, x.id, state))
    }
    apply()
    const skipped = pending.length - done.length
    record(
      `${accept ? 'Accepted' : 'Rejected'} ${done.length} suggestion${done.length === 1 ? '' : 's'}`,
      pid,
      () => {
        if (accept) update(pid, (p) => keepSent(p, { ...p, subject: start.subject, body: start.body, status: start.status }))
        done.forEach((x) => setProposalState(pid, msgId, x.id, 'pending'))
      },
      apply,
      skipped ? `Accepted ${done.length}; ${skipped} no longer matched the email, so they’re still pending` : undefined,
    )
  }

  const setRecipients = (to: string[]) => {
    if (!selected) return
    const { id: pid, to: prev } = selected
    const added = to.filter((x) => !prev.includes(x))
    const removed = prev.filter((x) => !to.includes(x))
    const label = added.length ? `Added ${added.join(', ')}` : `Removed ${removed.join(', ')}`
    update(pid, (p) => ({ ...p, to }))
    record(
      label,
      pid,
      () => update(pid, (p) => ({ ...p, to: prev })),
      () => update(pid, (p) => ({ ...p, to })),
    )
  }

  const addRecipient = (email: string) => selected && !selected.to.includes(email) && setRecipients([...selected.to, email])

  const addTopRecipient = () => {
    if (!selected) return
    const r = selected.brief?.recipients.find((r) => r.email && !selected.to.includes(r.email))
    if (r) addRecipient(r.email)
  }

  const editBody = () => {
    if (!selected || !hasEmail(selected)) return
    setShowDiff(false)
    focusLater('email-body')
  }

  const openChat = () => {
    setTab('chat')
    setRightOpen(true)
    focusLater('chat-input')
  }

  // Header BRIEF / CHAT buttons and ⌘⇧B: open that tab, or close if it's already showing.
  const togglePanel = (t: Tab) => {
    if (rightOpen && tab === t) return setRightOpen(false)
    setTab(t)
    setRightOpen(true)
  }

  const revertProposal = (msgId: string, propId: string) => {
    if (!selected) return
    const pid = selected.id
    const prop = findProposal(selected, msgId, propId)
    if (!prop || prop.state === 'pending') return
    const prev = prop.state
    if (prev === 'accepted' && !hasText(selected, prop.new)) return notify({ text: 'Can’t undo that one: you’ve edited that text since' })
    const apply = () => {
      if (prev === 'accepted') swapText(pid, prop.new, prop.old)
      setProposalState(pid, msgId, propId, 'pending')
    }
    apply()
    record(
      prev === 'accepted' ? 'Undid suggestion' : 'Brought suggestion back',
      pid,
      () => {
        if (prev === 'accepted') swapText(pid, prop.old, prop.new)
        setProposalState(pid, msgId, propId, prev)
      },
      apply,
    )
  }

  // ⌘/: with text selected in the email, ask the AI about it; otherwise jump
  // between the email and the chat box.
  const toggleChatFocus = () => {
    const editor = currentEditor()
    const sel = editor?.state.selection
    if (editor?.isFocused && sel && !sel.empty) return askAbout(editor.state.doc.textBetween(sel.from, sel.to, '\n'))
    if (document.activeElement?.id === 'chat-input' && selected && hasEmail(selected)) editBody()
    else openChat()
  }

  // ⌘N: a new chat from the chat panel, otherwise add organisations.
  const newThing = (el: HTMLElement) => {
    if (el.closest?.('#side-panel') && selected && hasEmail(selected)) newChat()
    else openAdd()
  }

  const replying = !!selected && !!activeChat(selected)?.messages.some((m) => m.pending)
  // Stops the reply being written in the chat that's showing.
  const stopReply = () => {
    const thread = selected && activeChat(selected)
    if (thread) stopJob(chatJobs.current, thread.id)
  }

  const goToNextReview = () => {
    const next = nextReviewId(selectedId)
    if (next) select(next)
  }

  // Re-bound every render so the handler always sees current state.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Setup has its own controls; ⌘, still opens Settings to connect the mailbox.
      if (!onboarded && !((e.metaKey || e.ctrlKey) && e.key === ',')) return
      const mod = e.metaKey || e.ctrlKey
      const el = e.target as HTMLElement
      const typing = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable

      // ⌘K is the palette everywhere, so any action is reachable mid-typing.
      // Exception: with text selected in the email it makes a link (handled by the editor).
      const linking = !!el.closest?.('#email-body') && !window.getSelection()?.isCollapsed
      if (mod && e.key.toLowerCase() === 'k' && !linking) {
        e.preventDefault()
        setPalette((v) => !v)
        return
      }
      // ⌘O: switch campaign or folder, from anywhere in the email view. The
      // switcher hangs off the sidebar, so bring that back first.
      if (mod && e.key.toLowerCase() === 'o' && view !== 'settings') {
        e.preventDefault()
        if (!switcherOpen) setLeftOpen(true)
        setSwitcherOpen((v) => !v)
        return
      }
      // ⌘N in the chat starts a new chat, even when the chat is a sheet over the email.
      if (mod && e.key.toLowerCase() === 'n' && !e.shiftKey && el.closest?.('#side-panel') && selected && hasEmail(selected)) {
        e.preventDefault()
        return newChat()
      }
      // Dialogs and sheets handle their own Escape; don't act behind them.
      if (overlayOpen) return
      // Esc stops a reply that's being written, before anything else it does.
      if (e.key === 'Escape' && replying && view === 'email') return stopReply()
      if (e.key === 'Escape' && typing) return el.blur()

      if (mod && e.key.toLowerCase() === 'z') {
        if (el.closest?.('#email-body')) return // the editor asks undoBridge itself
        if (typing && dirtyInput.current === el) return // native undo for what you just typed here
        e.preventDefault()
        return e.shiftKey ? appRedo() : appUndo()
      }

      // In Settings only ⌘, and Esc (back) apply; the email shortcuts don't.
      if (view === 'settings') {
        if (mod && e.key === ',') {
          e.preventDefault()
          closeSettings()
        } else if (e.key === 'Escape' && !typing) closeSettings()
        return
      }

      // Adding organisations: Esc goes back to the email; ⌘, still opens Settings.
      if (view === 'add') {
        if (mod && e.key === ',') {
          e.preventDefault()
          openSettings()
        } else if (e.key === 'Escape' && !typing) setView('email')
        return
      }

      // Modifier shortcuts work everywhere, including mid-typing, since most of
      // the time focus is in the email or the chat box.
      if (mod) {
        const key = e.key.toLowerCase()
        const run = (fn: () => void) => {
          e.preventDefault()
          fn()
        }
        if (key === ',') return run(() => openSettings())
        if (key === 'n' && !e.shiftKey) return run(() => newThing(el))
        if (key === 'enter') return run(e.shiftKey ? () => resolveNextProposal(true) : save)
        if (key === 'backspace' && e.shiftKey) return run(() => resolveNextProposal(false))
        if (key === '/') return run(toggleChatFocus)
        if (key === 'b' && e.shiftKey) return run(() => togglePanel('brief'))
        if (key === 'h' && e.shiftKey) return run(() => selected && hasEmail(selected) && setHistoryOpen((v) => !v))
        // ⌘\\ (left sidebar) is handled by shadcn's SidebarProvider.
        if ((key === '\\' || key === '|') && e.shiftKey) return run(() => setRightOpen((v) => !v))
        if (key === ']') return run(() => step(1))
        if (key === '[') return run(() => step(-1))
        if (key === 'd' && !e.shiftKey) return run(() => selected?.originalBody && setShowDiff((v) => !v))
        if (key === 'r' && !e.shiftKey) return run(regenerate)
        // Plain ⌘C is left alone for copying a selection.
        if (key === 'c' && e.shiftKey) return run(() => void copyEmail())
      }
      if (typing || mod || e.altKey) return

      const actions: Record<string, () => void> = {
        j: () => step(1),
        ArrowDown: () => step(1),
        k: () => step(-1),
        ArrowUp: () => step(-1),
        n: goToNextReview,
        '1': () => setFilter('review'),
        '2': () => setFilter('write'),
        '3': () => setFilter('all'),
        '4': () => setFilter('saved'),
        '5': () => setFilter('archived'),
        y: () => view === 'email' && selected && toggleArchive(selected.id),
        e: editBody,
        Enter: editBody,
        t: addTopRecipient,
        b: () => togglePanel('brief'),
        '/': openChat,
        a: () => resolveNextProposal(true),
        x: () => resolveNextProposal(false),
        c: () => openAdd(),
        Backspace: () => view === 'email' && selected && deleteProspect(selected.id),
        Delete: () => view === 'email' && selected && deleteProspect(selected.id),
        '?': () => setHelp(true),
      }
      const action = actions[e.key]
      if (action) {
        e.preventDefault()
        action()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- Deleted items ----
  type TrashEntry = TrashItem & { set: (at?: number) => void; purge: () => void }
  const campaignName = (id: string) => campaigns.find((c) => c.id === id)?.name || 'Untitled campaign'
  const trash: TrashEntry[] = [
    ...folders
      .filter((f) => f.deletedAt)
      .map<TrashEntry>((f) => ({
        key: `folder:${f.id}`,
        kind: 'folder',
        label: f.name || 'Untitled folder',
        context: `${campaigns.filter((c) => c.folderId === f.id && !c.deletedAt).length} campaigns`,
        deletedAt: f.deletedAt!,
        set: (at) => setFolderDeleted(f.id, at),
        purge: () => {
          const ids = campaigns.filter((c) => c.folderId === f.id).map((c) => c.id)
          setFolders((fs) => fs.filter((x) => x.id !== f.id))
          setCampaigns((cs) => cs.filter((c) => c.folderId !== f.id))
          setProspects((ps) => ps.filter((p) => !ids.includes(p.campaignId)))
        },
      })),
    ...campaigns
      .filter((c) => c.deletedAt)
      .map<TrashEntry>((c) => ({
        key: `campaign:${c.id}`,
        kind: 'campaign',
        label: c.name || 'Untitled campaign',
        context: `${prospects.filter((p) => p.campaignId === c.id && !p.deletedAt).length} organisations`,
        deletedAt: c.deletedAt!,
        set: (at) => {
          setCampaignDeleted(c.id, at)
          // Restoring a campaign from a deleted folder brings the folder back too.
          if (at === undefined) setFolderDeleted(c.folderId, undefined)
        },
        purge: () => {
          setCampaigns((cs) => cs.filter((x) => x.id !== c.id))
          setProspects((ps) => ps.filter((p) => p.campaignId !== c.id))
        },
      })),
    ...prospects
      .filter((p) => p.deletedAt)
      .map<TrashEntry>((p) => ({
        key: `org:${p.id}`,
        kind: 'organisation',
        label: p.company,
        context: campaignName(p.campaignId),
        deletedAt: p.deletedAt!,
        set: (at) => {
          setProspectDeleted(p.id, at)
          // Restoring an organisation from a deleted campaign brings the campaign back too.
          if (at === undefined) setCampaignDeleted(p.campaignId, undefined)
        },
        purge: () => setProspects((ps) => ps.filter((x) => x.id !== p.id)),
      })),
    ...voices
      .filter((v) => v.deletedAt)
      .map<TrashEntry>((v) => ({
        key: `voice:${v.id}`,
        kind: 'voice',
        label: v.name,
        context: v.description,
        deletedAt: v.deletedAt!,
        set: (at) => setVoiceDeleted(v.id, at),
        purge: () => setVoices((vs) => vs.filter((x) => x.id !== v.id)),
      })),
    ...voices.flatMap((v) =>
      v.notes
        .filter((n) => n.deletedAt)
        .map<TrashEntry>((n) => ({
          key: `note:${v.id}:${n.text}`,
          kind: 'note',
          label: n.text,
          context: `${v.name} voice`,
          deletedAt: n.deletedAt!,
          set: (at) => setNoteDeleted(v.id, n.text, at),
          purge: () => setVoices((vs) => vs.map((x) => (x.id !== v.id ? x : { ...x, notes: x.notes.filter((y) => y.text !== n.text) }))),
        })),
    ),
    ...voices.flatMap((v) =>
      (v.examples ?? [])
        .filter((e) => e.deletedAt)
        .map<TrashEntry>((e) => ({
          key: `example:${v.id}:${e.id}`,
          kind: 'example',
          label: e.final.split('\n').find((l) => l.trim()) ?? 'Example email',
          context: `${v.name} voice`,
          deletedAt: e.deletedAt!,
          set: (at) => setExampleDeleted(v.id, e.id, at),
          purge: () => setVoices((vs) => vs.map((x) => (x.id !== v.id ? x : { ...x, examples: x.examples?.filter((y) => y.id !== e.id) }))),
        })),
    ),
    ...prospects.flatMap((p) =>
      p.chats
        .filter((c) => c.deletedAt)
        .map<TrashEntry>((c) => ({
          key: `chat:${p.id}:${c.id}`,
          kind: 'chat',
          label: c.title,
          context: `${p.company} · ${c.messages.length} messages`,
          deletedAt: c.deletedAt!,
          set: (at) => setChatDeleted(p.id, c.id, at),
          purge: () => update(p.id, (q) => ({ ...q, chats: q.chats.filter((x) => x.id !== c.id) })),
        })),
    ),
    ...snippets
      .filter((s) => s.deletedAt)
      .map<TrashEntry>((s) => ({
        key: `snippet:${s.id}`,
        kind: 'snippet',
        label: s.name || 'Untitled snippet',
        context: scopeLabel(s.scope),
        deletedAt: s.deletedAt!,
        set: (at) => setSnippetDeleted(s.id, at),
        purge: () => setSnippets((ss) => ss.filter((x) => x.id !== s.id)),
      })),
    ...prospects.flatMap((p) =>
      p.versions
        .filter((v) => v.deletedAt)
        .map<TrashEntry>((v) => ({
          key: `version:${p.id}:${v.id}`,
          kind: 'version',
          label: v.label,
          context: p.company,
          deletedAt: v.deletedAt!,
          set: (at) => setVersionDeleted(p.id, v.id, at),
          purge: () => update(p.id, (q) => ({ ...q, versions: q.versions.filter((x) => x.id !== v.id) })),
        })),
    ),
  ]
  const trashEntry = (item: TrashItem) => trash.find((t) => t.key === item.key)

  const restoreItem = (item: TrashItem) => {
    const entry = trashEntry(item)
    if (!entry) return
    entry.set(undefined)
    record(
      `Restored ${item.label}`,
      undefined,
      () => entry.set(item.deletedAt),
      () => entry.set(undefined),
    )
  }

  // Permanent: not on the undo stack, which is why the UI confirms first.
  const purgeItem = (item: TrashItem) => {
    trashEntry(item)?.purge()
    notify({ text: `Permanently deleted ${item.label}` })
  }

  const emptyTrash = () => {
    trash.forEach((t) => t.purge())
    notify({ text: `Permanently deleted ${trash.length} item${trash.length === 1 ? '' : 's'}` })
  }

  const undoTop = undoStack.current.at(-1)
  const redoTop = redoStack.current.at(-1)
  const commands: PaletteCommand[] = [
    ...inCampaign.map<PaletteCommand>((p) => ({
      id: `go-${p.id}`,
      group: 'Organisations',
      label: p.company,
      icon: <span className={`mx-[5px] size-1.5 shrink-0 rounded-full ${dot(p)}`} />,
      hint: statusStyle[p.status].label + (p.archivedAt ? ' · archived' : ''),
      run: () => select(p.id),
    })),
    ...(undoTop ? [{ id: 'undo', group: 'Actions' as const, label: `Undo: ${undoTop.label}`, icon: <Undo2 />, shortcut: '⌘Z', run: appUndo }] : []),
    ...(redoTop ? [{ id: 'redo', group: 'Actions' as const, label: `Redo: ${redoTop.label}`, icon: <Redo2 />, shortcut: '⌘⇧Z', run: appRedo }] : []),
    { id: 'save', group: 'Actions', label: 'Save to drafts', icon: <Inbox />, shortcut: '⌘↵', run: save },
    ...(selected && hasEmail(selected)
      ? [
          { id: 'copy', group: 'Actions' as const, label: 'Copy email (for a contact form)', icon: <Copy />, shortcut: '⌘⇧C', run: () => void copyEmail() },
          { id: 'copy-subject', group: 'Actions' as const, label: 'Copy subject', icon: <Copy />, run: () => void copyEmail('subject') },
          selected.status === 'sent'
            ? { id: 'unsend', group: 'Actions' as const, label: 'Mark as not sent', icon: <Send />, run: () => markNotSent(selected.id) }
            : {
                id: 'mark-sent',
                group: 'Actions' as const,
                label: 'Mark as sent…',
                icon: <Send />,
                run: () => {
                  setView('email')
                  setMarkSentOpen(true)
                },
              },
        ]
      : []),
    ...(selected
      ? [
          {
            id: 'archive',
            group: 'Actions' as const,
            label: `${selected.archivedAt ? 'Unarchive' : 'Archive'} ${selected.company}`,
            icon: selected.archivedAt ? <ArchiveRestore /> : <Archive />,
            shortcut: 'Y',
            run: () => toggleArchive(selected.id),
          },
        ]
      : []),
    ...(selected?.originalBody
      ? [{ id: 'diff', group: 'Actions' as const, label: 'Compare with the AI draft', icon: <GitCompare />, shortcut: '⌘D', run: () => setShowDiff((v) => !v) }]
      : []),
    { id: 'regen', group: 'Actions', label: 'Regenerate draft', icon: <RefreshCw />, shortcut: '⌘R', run: regenerate },
    { id: 'chat', group: 'Actions', label: 'Chat with the AI', icon: <MessageSquare />, shortcut: '⌘/', run: openChat },
    { id: 'brief', group: 'Actions', label: 'Show brief', icon: <FileText />, shortcut: '⌘⇧B', run: () => togglePanel('brief') },
    { id: 'left', group: 'Actions', label: 'Toggle sidebar', icon: <PanelLeft />, shortcut: '⌘\\', run: () => setLeftOpen((v) => !v) },
    {
      id: 'right',
      group: 'Actions',
      label: rightOpen ? 'Hide brief & chat' : 'Show brief & chat',
      icon: <PanelRight />,
      shortcut: '⌘⇧\\',
      run: () => setRightOpen((v) => !v),
    },
    { id: 'add', group: 'Actions', label: 'Add to campaign', icon: <Plus />, shortcut: '⌘N', run: () => openAdd() },
    { id: 'find', group: 'Actions', label: 'Find organisations with AI', icon: <Sparkles />, run: () => openFind(campaign.id) },
    {
      id: 'theme',
      group: 'Actions',
      label: theme === 'dark' ? 'Light mode' : 'Dark mode',
      icon: theme === 'dark' ? <Sun /> : <Moon />,
      run: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    },
    { id: 'help', group: 'Actions', label: 'Keyboard shortcuts', icon: <Keyboard />, shortcut: '?', run: () => setHelp(true) },
    { id: 'settings', group: 'Actions', label: 'Settings', icon: <Settings />, shortcut: '⌘,', run: () => openSettings() },
    { id: 'new-chat', group: 'Actions', label: 'New chat', icon: <MessageSquarePlus />, run: newChat },
    ...(replying && selected ? [{ id: 'stop', group: 'Actions' as const, label: 'Stop the reply', icon: <Square />, run: stopReply }] : []),
    ...(selected && activeChat(selected)
      ? [
          {
            id: 'delete-chat',
            group: 'Actions' as const,
            label: `Delete chat “${activeChat(selected)!.title}”`,
            icon: <Trash2 />,
            run: () => deleteChat(activeChat(selected)!.id),
          },
        ]
      : []),
    ...(selected
      ? [
          {
            id: 'delete-org',
            group: 'Actions' as const,
            label: `Delete ${selected.company}`,
            icon: <Trash2 />,
            shortcut: '⌫',
            run: () => deleteProspect(selected.id),
          },
        ]
      : []),
    {
      id: 'trash',
      group: 'Actions',
      label: `Deleted items${trash.length ? ` (${trash.length})` : ''}`,
      icon: <Trash2 />,
      run: () => openSettings({ kind: 'trash' }),
    },
    ...aliveVoices
      .filter((v) => v.id !== voice.id)
      .map<PaletteCommand>((v) => ({
        id: `voice-${v.id}`,
        group: 'Campaigns & voices',
        label: `Write as ${v.name}`,
        icon: <PenLine />,
        run: () => setVoice(v.id),
      })),
    { id: 'voices', group: 'Campaigns & voices', label: 'Edit voices', icon: <PenLine />, run: editVoices },
    { id: 'snippets', group: 'Campaigns & voices', label: 'Edit snippets', icon: <Slash />, run: () => openSettings({ kind: 'snippets' }) },
    ...aliveCampaigns
      .filter((c) => c.id !== campaign.id)
      .map<PaletteCommand>((c) => ({
        id: `campaign-${c.id}`,
        group: 'Campaigns & voices',
        label: `Switch to ${c.name || 'Untitled campaign'}`,
        hint: folders.find((f) => f.id === c.folderId)?.name,
        icon: <Flag />,
        run: () => switchCampaign(c.id),
      })),
    {
      id: 'folder',
      group: 'Campaigns & voices',
      label: `Edit ${folder.name || 'folder'} context`,
      icon: <FolderOpen />,
      run: () => openSettings({ kind: 'folder', id: folder.id }),
    },
    {
      id: 'new-folder',
      group: 'Campaigns & voices',
      label: 'New folder',
      icon: <FolderPlus />,
      run: () => openSettings({ kind: 'folder', id: createFolder() }),
    },
    {
      id: 'campaign',
      group: 'Campaigns & voices',
      label: 'Edit campaign notes',
      icon: <Flag />,
      run: () => openSettings({ kind: 'campaign', id: campaignId }),
    },
    {
      id: 'new-campaign',
      group: 'Campaigns & voices',
      label: 'New campaign',
      icon: <Plus />,
      run: () => openSettings({ kind: 'campaign', id: createCampaign() }),
    },
  ]

  const queuePosition = prospects.filter((p) => p.status === 'queued' && !p.deletedAt).findIndex((p) => p.id === selectedId)

  // From the Add page. One-click adds from "Find with AI" stay on the page.
  const addProspects = (orgs: { name: string; website: string; note: string; discovery?: string }[], { stay = false } = {}) => {
    const added = orgs.map<Prospect>(({ name, website, note, discovery }) => ({
      id: crypto.randomUUID(),
      // Not campaignId: that can point at a deleted campaign the page has fallen back from.
      campaignId: campaign.id,
      company: name,
      domain: website,
      note: note || undefined,
      discovery,
      status: 'queued',
      progress: [],
      subject: '',
      originalBody: '',
      body: '',
      to: [],
      chats: [],
      versions: [],
    }))
    const ids = added.map((p) => p.id)
    const apply = () => setProspects((ps) => [...ps.filter((p) => !ids.includes(p.id)), ...added])
    apply()
    record(
      `Added ${added.length === 1 ? added[0].company : added.length} to ${campaign.name || 'this campaign'}`,
      undefined,
      () => {
        // Don't keep researching something that's no longer there.
        for (const id of ids) {
          if (!researchJobs.current.has(id)) continue
          dropped.current.add(id)
          stopJob(researchJobs.current, id)
        }
        setProspects((ps) => ps.filter((p) => !ids.includes(p.id)))
      },
      apply,
    )
    // New ones are queued, so only All lists them.
    setFilter('all')
    // Otherwise show the first one researching.
    if (!stay) select(added[0].id)
  }

  // ---- Find with AI. Runs here rather than in the Add page, so a search
  // carries on (and its results land) while you look at emails. ----
  const discoveryJobs = useRef(new Map<string, string>()) // campaign id → job id
  const viewRef = useRef(view)
  viewRef.current = view
  const addModeRef = useRef(addMode)
  addModeRef.current = addMode
  const campaignIdRef = useRef(campaign.id)
  campaignIdRef.current = campaign.id

  const updateDiscovery = (cid: string, fn: (d: Discovery) => Discovery) =>
    setCampaigns((cs) => cs.map((c) => (c.id === cid ? { ...c, discovery: fn(c.discovery ?? { rounds: [], dismissed: [] }) } : c)))
  const updateRound = (cid: string, rid: string, fn: (r: DiscoveryRound) => DiscoveryRound) =>
    updateDiscovery(cid, (d) => ({ ...d, rounds: d.rounds.map((r) => (r.id === rid ? fn(r) : r)) }))

  const openFind = (cid: string) => {
    // From a toast, the campaign may have been deleted since.
    const c = campaignsRef.current.find((c) => c.id === cid)
    if (!c || c.deletedAt || foldersRef.current.find((f) => f.id === c.folderId)?.deletedAt) return
    if (cid !== campaignIdRef.current) setCampaignId(cid)
    setAddMode('find')
    setView('add')
  }

  const discover = async (query: string) => {
    const cid = campaign.id
    if (discoveryJobs.current.has(cid) || !query.trim()) return
    const d = campaign.discovery ?? { rounds: [], dismissed: [] }
    // Everything already in the campaign, suggested or turned down.
    const exclude = [...new Set([...inCampaign.map((p) => p.company), ...d.dismissed, ...d.rounds.flatMap((r) => r.candidates.map((c) => c.name))])]
    const rid = crypto.randomUUID()
    const jobId = crypto.randomUUID()
    updateDiscovery(cid, (d) => ({ ...d, rounds: [...d.rounds, { id: rid, query: query.trim(), status: 'searching', steps: [], candidates: [] }] }))
    discoveryJobs.current.set(cid, jobId)
    // Organisations stream in as they're found, and come back again at the end.
    const got = new Set(exclude.map(orgKey))
    let found = 0
    const addFound = (cands: Candidate[]) => {
      const fresh = cands.filter((c) => !got.has(orgKey(c.name)))
      if (!fresh.length) return
      fresh.forEach((c) => got.add(orgKey(c.name)))
      found += fresh.length
      // Skipping any in other rounds too: undoing "New search" can bring some back mid-search.
      updateDiscovery(cid, (d) => {
        const other = new Set(d.rounds.filter((r) => r.id !== rid).flatMap((r) => r.candidates.map((c) => orgKey(c.name))))
        const add = fresh.filter((c) => !other.has(orgKey(c.name)))
        return { ...d, rounds: d.rounds.map((r) => (r.id === rid ? { ...r, candidates: [...r.candidates, ...add] } : r)) }
      })
    }
    jobs.current.set(jobId, (e) => {
      if (e.kind === 'step') updateRound(cid, rid, (r) => ({ ...r, steps: [...r.steps, e.text] }))
      if (e.kind === 'candidate') addFound([e.candidate])
    })
    const res = window.api
      ? await window.api.claude.discover({ jobId, query: query.trim(), campaignNotes: campaignNotes(cid), exclude, earlier: d.rounds.map((r) => r.query) })
      : ({ ok: false, error: 'Finding organisations runs in the Inroad desktop app.' } as const)
    jobs.current.delete(jobId)
    discoveryJobs.current.delete(cid)
    if (res.ok) addFound(res.value)
    const stopped = !res.ok && res.error === 'Stopped.'
    updateRound(cid, rid, (r) => ({ ...r, status: res.ok ? 'done' : stopped ? 'stopped' : 'failed', error: res.ok || stopped ? undefined : res.error }))
    // Say so if you've moved on from the results, unless the campaign was deleted meanwhile.
    const c = campaignsRef.current.find((c) => c.id === cid)
    const gone = !c || !!c.deletedAt || !!foldersRef.current.find((f) => f.id === c.folderId)?.deletedAt
    if (stopped || gone || (viewRef.current === 'add' && addModeRef.current === 'find' && campaignIdRef.current === cid)) return
    const name = c.name || 'this campaign'
    notify({
      text: !res.ok ? `Couldn’t finish finding organisations for ${name}` : found ? `Found ${found} for ${name}` : `Found nothing new for ${name}`,
      action: { label: 'View', run: () => openFind(cid) },
    })
  }

  // Suggestions not yet added or dismissed, for the sidebar.
  const addedIds = Object.fromEntries(inCampaign.map((p) => [orgKey(p.company), p.id]))
  const discoveryStatus = (() => {
    const d = campaign.discovery
    if (!d?.rounds.length || (view === 'add' && addMode === 'find')) return undefined
    const dismissed = new Set(d.dismissed.map(orgKey))
    const count = d.rounds.flatMap((r) => r.candidates).filter((c) => !dismissed.has(orgKey(c.name)) && !addedIds[orgKey(c.name)]).length
    const searching = discoveryJobs.current.has(campaign.id) || d.rounds.some((r) => r.status === 'searching')
    return searching || count ? { searching, count } : undefined
  })()

  const stopDiscovery = () => {
    const jobId = discoveryJobs.current.get(campaign.id)
    if (jobId) void window.api?.claude.cancel(jobId)
  }

  // What research is told about why it was suggested.
  const describeCandidate = (c: Candidate) =>
    [c.why, ...c.sources.map((s) => (s.url ? `Source: ${s.title ? `${s.title} — ` : ''}${s.url}` : `Source: ${s.title}`))].join('\n')

  const addCandidates = (all: Candidate[]) => {
    // Once each, and not if it's already in the campaign.
    const keys = new Set(Object.keys(addedIds))
    const cands = all.filter((c) => !keys.has(orgKey(c.name)) && !!keys.add(orgKey(c.name)))
    if (cands.length)
      addProspects(
        cands.map((c) => ({ name: c.name, website: c.website, note: '', discovery: describeCandidate(c) })),
        { stay: true },
      )
  }

  // Clears the suggestions for a fresh search (dismissed ones stay dismissed);
  // undo brings them back.
  const newSearch = () => {
    const cid = campaign.id
    const prev = campaign.discovery
    if (!prev || discoveryJobs.current.has(cid)) return
    const query = prev.rounds[0]?.query ?? ''
    // Only these rounds come and go, so a search started since isn't touched.
    const ids = new Set(prev.rounds.map((r) => r.id))
    const clear = () => updateDiscovery(cid, (d) => ({ ...d, rounds: d.rounds.filter((r) => !ids.has(r.id)) }))
    clear()
    setFindText(query)
    record(
      'Cleared the suggestions',
      undefined,
      () =>
        updateDiscovery(cid, (d) => {
          // A search since may have found some of the same organisations again; keep the newer copy.
          const later = d.rounds.filter((r) => !ids.has(r.id))
          const seen = new Set(later.flatMap((r) => r.candidates.map((c) => orgKey(c.name))))
          const restored = prev.rounds.map((r) => ({ ...r, candidates: r.candidates.filter((c) => !seen.has(orgKey(c.name))) }))
          return { ...d, rounds: [...restored, ...later] }
        }),
      clear,
    )
  }

  // Dismissed suggestions are hidden, and the agent is told not to suggest them again.
  const setDismissed = (cid: string, name: string, on: boolean) =>
    updateDiscovery(cid, (d) => ({ ...d, dismissed: on ? [...d.dismissed.filter((n) => n !== name), name] : d.dismissed.filter((n) => n !== name) }))
  const dismissCandidate = (name: string, on = true) => {
    const cid = campaign.id
    setDismissed(cid, name, on)
    record(
      `${on ? 'Dismissed' : 'Restored'} ${name}`,
      undefined,
      () => setDismissed(cid, name, !on),
      () => setDismissed(cid, name, on),
    )
  }

  // A suggestion as Claude will see it in the transcript of earlier turns.
  const describe = (m: ChatMsg) =>
    [
      m.quote ? `[About this part of the email: “${m.quote}”]` : '',
      m.files?.length ? `[Attached ${m.files.map((f) => `“${f.name}”`).join(', ')}]` : '',
      m.text,
      ...(m.proposals ?? []).map((x) => `[Suggested replacing “${x.old}” with “${x.new}” — ${x.state === 'pending' ? 'not yet decided' : x.state}]`),
      m.stopped ? '[The user stopped this reply here]' : '',
    ]
      .filter(Boolean)
      .join('\n')

  // A passage of the email attached to the next chat message (highlight + Ask AI, or ⌘/).
  const [chatQuote, setChatQuote] = useState<{ pid: string; text: string } | null>(null)
  const askAbout = (text: string) => {
    if (!selected || !hasEmail(selected) || !text.trim()) return
    setChatQuote({ pid: selected.id, text: text.trim() })
    openChat()
  }

  const sendChat = async (text: string, files: ChatAttachment[] = []) => {
    if (!selected) return
    const p = selected
    const pid = p.id
    const current = activeChat(p)
    if (current?.messages.some((m) => m.pending)) return
    // No chat yet: start one, named after the first message (or its file).
    const title = (text || files[0]?.name || 'New chat').slice(0, 40)
    const thread: ChatThread = current ?? { id: crypto.randomUUID(), title, createdAt: Date.now(), messages: [] }
    const chatId = thread.id
    const history = thread.messages.filter((m) => !m.error).map((m) => ({ role: m.role, text: describe(m) }))
    const replyId = crypto.randomUUID()
    const quote = chatQuote?.pid === pid ? chatQuote.text : undefined
    if (quote) setChatQuote(null)
    const userMsg: ChatMsg = { id: crypto.randomUUID(), role: 'user', text, quote, ...(files.length ? { files } : {}) }
    // Every turn starts afresh, so the AI gets the files attached in this chat:
    // newest first up to the size cap, skipping any whose turn failed (a file
    // the AI rejected would otherwise break every later message).
    const earlier = thread.messages.flatMap((m, i) => (thread.messages[i + 1]?.error ? [] : (m.files ?? [])))
    let budget = CHAT_TOTAL_MAX
    const chatFiles = [...earlier, ...files]
      .reverse()
      .filter((f) => (budget -= f.size) >= 0)
      .reverse()
      .map(({ id, name, size, mime }) => ({ id, name, size, mime }))
    const reply: ChatMsg = { id: replyId, role: 'assistant', text: '', pending: true }
    update(pid, (q) => ({
      ...q,
      activeChatId: chatId,
      chats: q.chats.some((c) => c.id === chatId)
        ? q.chats.map((c) => (c.id === chatId ? { ...c, title: c.messages.length ? c.title : title, messages: [...c.messages, userMsg, reply] } : c))
        : [...q.chats, { ...thread, title, messages: [userMsg, reply] }],
    }))
    const setReply = (fn: (m: ChatMsg) => ChatMsg) =>
      update(pid, (q) => ({
        ...q,
        chats: q.chats.map((c) => (c.id !== chatId ? c : { ...c, messages: c.messages.map((m) => (m.id === replyId ? fn(m) : m)) })),
      }))
    if (!window.api) return setReply((m) => ({ ...m, pending: false, error: true, text: 'Chat runs in the Inroad desktop app.' }))

    const jobId = crypto.randomUUID()
    jobs.current.set(jobId, (e) => e.kind !== 'candidate' && setReply((m) => (e.kind === 'delta' ? { ...m, text: m.text + e.text } : { ...m, step: e.text })))
    chatJobs.current.set(chatId, jobId)
    const res = await window.api.claude.chat({
      jobId,
      ...claudeContext(p),
      brief: p.brief,
      subject: p.subject,
      body: p.body,
      comments: (p.comments ?? []).filter((c) => !c.dismissed).map(({ quote, comment, kind }) => ({ quote, comment, kind })),
      history,
      message: text || '(See the attached file.)',
      quote,
      files: chatFiles,
    })
    jobs.current.delete(jobId)
    chatJobs.current.delete(chatId)
    if (!res.ok) return setReply((m) => ({ ...m, pending: false, step: undefined, error: true, text: res.error }))
    setReply((m) => ({
      ...m,
      pending: false,
      step: undefined,
      stopped: res.value.stopped,
      text: res.value.text,
      proposals: res.value.proposals.map((x) => ({ ...x, id: crypto.randomUUID(), state: 'pending' })),
      comments: res.value.comments,
    }))
    if (res.value.comments.length) update(pid, (q) => ({ ...q, comments: [...(q.comments ?? []), ...stamp(res.value.comments, 'chat')] }))
  }

  const setCommentDismissed = (pid: string, id: string, dismissed: boolean) =>
    update(pid, (q) => ({ ...q, comments: q.comments?.map((c) => (c.id === id ? { ...c, dismissed } : c)) }))

  const dismissComment = (id: string) => {
    if (!selected) return
    const pid = selected.id
    setCommentDismissed(pid, id, true)
    record(
      'Dismissed comment',
      pid,
      () => setCommentDismissed(pid, id, false),
      () => setCommentDismissed(pid, id, true),
    )
  }

  // Settings → Data. Not undoable (the dialog confirms first); research still
  // running finishes into nothing, and saves waiting to reach the mailbox are cancelled.
  // Fills in the blank first-run campaign and voice from what setup collected.
  const finishOnboarding = (r: OnboardingResult) => {
    updateFolder(folder.id, { name: r.folder.name.trim(), notes: r.folder.notes.trim() })
    updateCampaign(campaign.id, { name: r.campaign.name.trim(), notes: r.campaign.notes.trim() })
    updateVoice(voice.id, {
      notes: [...voice.notes, ...r.rules.map((text) => ({ text, fresh: false }))],
      examples: [...(voice.examples ?? []), ...r.emails.map((final) => ({ id: crypto.randomUUID(), at: Date.now(), final }))],
    })
    setOnboarded(true)
    openAdd()
  }

  const startFresh = () => {
    const fresh = firstRun()
    discoveryJobs.current.forEach((jobId) => void window.api?.claude.cancel(jobId))
    Object.values(commitTimers.current).forEach(clearTimeout)
    commitTimers.current = {}
    undoStack.current = []
    redoStack.current = []
    setProspects(fresh.prospects)
    setCampaigns(fresh.campaigns)
    setVoices(fresh.voices)
    setCampaignId(fresh.campaignId)
    setSelectedId(fresh.selectedId)
    setFolders(fresh.folders)
    setSnippets([])
    setOnboarded(false)
    setView('email')
    notify({ text: 'Started fresh' })
  }

  const panel = selected && (
    <RightPanel
      prospect={selected}
      tab={tab}
      onTab={setTab}
      onClose={() => setRightOpen(false)}
      onAddRecipient={addRecipient}
      onNote={(note) => update(selected.id, (p) => ({ ...p, note }))}
      onProposal={resolveProposal}
      onProposalsAll={resolveAllProposals}
      onRevertProposal={revertProposal}
      onSend={sendChat}
      onStop={stopReply}
      quote={chatQuote?.pid === selected.id ? chatQuote.text : null}
      onClearQuote={() => setChatQuote(null)}
      onNewChat={newChat}
      onSelectChat={selectChat}
      onDeleteChat={deleteChat}
    />
  )

  const main = selected ? (
    <Editor
      prospect={selected}
      bodyStyle={emailStyleVars(emailStyle) as CSSProperties}
      voiceName={voice.name}
      attachments={campaign.attachments}
      queuePosition={queuePosition}
      showDiff={showDiff}
      onToggleDiff={() => setShowDiff((v) => !v)}
      regenerating={regeneratingId === selected.id}
      onRegenerate={regenerate}
      onRestoreVersion={restoreVersion}
      onDeleteVersion={deleteVersion}
      historyOpen={historyOpen}
      onHistoryOpenChange={setHistoryOpen}
      onChange={(patch) => (patch.to ? setRecipients(patch.to) : update(selected.id, (p) => ({ ...p, ...patch })))}
      onRetry={(website) => update(selected.id, (p) => ({ ...p, status: 'queued', progress: [], error: undefined, domain: website || p.domain }))}
      onStopResearch={() => stopJob(researchJobs.current, selected.id)}
      onSave={save}
      onCopy={() => void copyEmail()}
      markSentOpen={markSentShown}
      onMarkSentOpenChange={setMarkSentOpen}
      onMarkSent={(note) => markSent(selected.id, note)}
      onMarkNotSent={() => markNotSent(selected.id)}
      onArchive={() => toggleArchive(selected.id)}
      panelTab={rightOpen ? tab : null}
      onPanel={togglePanel}
      onDismissComment={dismissComment}
      proposals={(activeChat(selected)?.messages ?? []).flatMap((m) => (m.proposals ?? []).filter((x) => x.state === 'pending').map((x) => ({ ...x, msgId: m.id })))}
      onProposal={resolveProposal}
      onAsk={askAbout}
      snippets={snippetsFor(snippets, campaign).map((s) => ({ id: s.id, name: s.name, text: s.text, scope: scopeLabel(s.scope) }))}
      snippetScopes={[
        { value: 'global', label: 'Everywhere' },
        { value: 'folder', label: folder.name || 'This folder' },
        { value: 'campaign', label: campaign.name || 'This campaign' },
      ]}
      onSaveSnippet={(name, text, scope) =>
        addSnippet(
          { name, text, scope: scope === 'folder' ? { kind: 'folder', id: folder.id } : scope === 'campaign' ? { kind: 'campaign', id: campaign.id } : { kind: 'global' } },
          `Saved “${name}”. Type / in an email to use it.`,
        )
      }
    />
  ) : (
    <div className="flex h-full min-w-0 flex-col">
      <TopBar />
      <div className="mx-auto w-full max-w-[600px] px-6 pt-12">
      <h2 className="mb-2 font-heading text-2xl font-medium">Nothing in {campaign.name || 'this campaign'} yet</h2>
      <p className="mb-8 text-muted-foreground">
        {campaign.notes.trim()
          ? `Add the organisations you want to reach. The AI researches each one${campaign.researchOnly ? '' : ' and drafts an email'}.`
          : `Start with the campaign notes: what you’re asking for, the details the AI should mention, and what to look for when researching. Then add the organisations you want to reach.`}
      </p>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
        {!campaign.notes.trim() && (
          <Button className="h-9 rounded-full px-4" onClick={() => openSettings({ kind: 'campaign', id: campaign.id })}>
            Write campaign notes
          </Button>
        )}
        {campaign.notes.trim() ? (
          <Button className="h-9 rounded-full px-4" onClick={() => openAdd()}>
            Add organisations <span className="opacity-60">⌘N</span>
          </Button>
        ) : (
          <button className="text-muted-foreground hover:text-foreground" onClick={() => openAdd()}>
            Add organisations <Shortcut keys="⌘N" />
          </button>
        )}
      </div>
      </div>
    </div>
  )

  if (!onboarded)
    return (
      <TooltipProvider delayDuration={300}>
        <AgentProvider provider={settings?.aiProvider}>
          <Onboarding onFinish={finishOnboarding} onSkip={() => setOnboarded(true)} settings={settings} onSettings={setSettings} />
        </AgentProvider>
        <Toaster theme={theme} position="bottom-center" />
      </TooltipProvider>
    )

  return (
    <TooltipProvider delayDuration={300}>
      <AgentProvider provider={settings?.aiProvider}>
      <SidebarProvider open={leftOpen} onOpenChange={setLeftOpen} className="h-svh min-h-0 overflow-hidden" style={{ '--sidebar-width': '18rem' } as CSSProperties}>
        {view === 'settings' ? (
          <>
            <SettingsSidebar
              page={settingsPage}
              onPage={setSettingsPage}
              onBack={closeSettings}
              folders={aliveFolders}
              campaigns={aliveCampaigns}
              voices={aliveVoices}
              trashCount={trash.length}
              onNewFolder={() => openSettings({ kind: 'folder', id: createFolder() })}
              onNewCampaign={(folderId) => openSettings({ kind: 'campaign', id: createCampaign(folderId) })}
              onNewVoice={() => openSettings({ kind: 'voice', id: createVoice() })}
            />
            <SidebarInset className="@container min-w-0 overflow-hidden">
              <SettingsView
                page={settingsPage}
                onPage={setSettingsPage}
                settings={settings}
                onSettings={setSettings}
                emailStyle={emailStyle}
                onEmailStyle={setEmailStyle}
                theme={theme}
                onTheme={setTheme}
                trash={trash}
                onRestore={restoreItem}
                onPurge={purgeItem}
                onEmptyTrash={emptyTrash}
                onReset={startFresh}
                folders={aliveFolders}
                campaigns={aliveCampaigns}
                voices={aliveVoices}
                onUpdateFolder={updateFolder}
                onDeleteFolder={deleteFolder}
                onUpdateCampaign={updateCampaign}
                onDeleteCampaign={deleteCampaign}
                onAttach={attachFiles}
                onRemoveAttachment={removeAttachment}
                onUpdateVoice={updateVoice}
                onDeleteVoice={deleteVoice}
                onAddVoiceNote={addVoiceNote}
                onDeleteVoiceNote={deleteVoiceNote}
                onAddExample={addExample}
                onDeleteExample={deleteExample}
                snippets={snippets.filter((s) => !s.deletedAt)}
                onAddSnippet={() => addSnippet({ name: '', text: '', scope: { kind: 'global' } })}
                onUpdateSnippet={updateSnippet}
                onDeleteSnippet={deleteSnippet}
              />
            </SidebarInset>
          </>
        ) : (
          <>
            <AppSidebar
              prospects={inCampaign}
              selectedId={selectedId}
              onSelect={select}
              onAdd={() => openAdd()}
              discovery={discoveryStatus}
              onOpenDiscovery={() => openFind(campaign.id)}
              onDeleteProspect={deleteProspect}
              onArchiveProspect={toggleArchive}
              filter={filter}
              onFilter={setFilter}
              onOpenPalette={() => setPalette(true)}
              onOpenSettings={() => openSettings()}
              mailReady={mailReady}
              onConnectMail={() => openSettings({ kind: 'mailbox' })}
              switcher={{
                open: switcherOpen,
                onOpenChange: setSwitcherOpen,
                folders: aliveFolders,
                campaigns: aliveCampaigns,
                allProspects: prospects.filter((p) => !p.deletedAt),
                campaignId: campaign.id,
                voices: aliveVoices,
                onSwitchCampaign: switchCampaign,
                onEditCampaign: (id) => openSettings({ kind: 'campaign', id }),
                onEditFolder: (id) => openSettings({ kind: 'folder', id }),
                onNewCampaign: () => openSettings({ kind: 'campaign', id: createCampaign() }),
                onNewFolder: () => openSettings({ kind: 'folder', id: createFolder() }),
                onSetVoice: setVoice,
              }}
            />
            <SidebarInset className="min-w-0 overflow-hidden">
              {view === 'add' ? (
                <AddCompaniesPage
                  campaign={campaign}
                  voiceName={voice.name}
                  text={addText}
                  onText={setAddText}
                  onAdd={addProspects}
                  onCancel={() => setView('email')}
                  onResearchOnly={(researchOnly) => updateCampaign(campaign.id, { researchOnly })}
                  mode={addMode}
                  onMode={setAddMode}
                  find={{
                    discovery: campaign.discovery,
                    addedIds,
                    text: findText,
                    onText: setFindText,
                    onDiscover: (q) => void discover(q),
                    onStop: stopDiscovery,
                    onAdd: addCandidates,
                    onDismiss: dismissCandidate,
                    onOpen: select,
                    onNewSearch: newSearch,
                  }}
                />
              ) : rightDocks && selected && view === 'email' ? (
                <ResizablePanelGroup
                  orientation="horizontal"
                  className="h-full"
                  // Fires on every drag step (unlike Panel.onResize, which waits for a
                  // ResizeObserver), so the panel's content appears as soon as it opens.
                  onLayoutChange={(layout) => {
                    const open = (layout.panel ?? 0) > 0.5
                    if (open !== rightOpen) setRightOpen(open)
                  }}
                >
                  <ResizablePanel id="main" minSize={420}>
                    {main}
                  </ResizablePanel>
                  {/* Still draggable, but no line: the column sits on the page like the sidebar. */}
                  <ResizableHandle className="bg-transparent" />
                  <ResizablePanel
                    id="panel"
                    panelRef={rightPanelRef}
                    collapsible
                    collapsedSize={0}
                    defaultSize={rightOpen ? 380 : 0}
                    minSize={300}
                    maxSize={640}
                  >
                    {rightOpen && panel}
                  </ResizablePanel>
                </ResizablePanelGroup>
              ) : (
                main
              )}
            </SidebarInset>
          </>
        )}

        {!rightDocks && (
          <Sheet open={sheetOpen} onOpenChange={setRightOpen}>
            <SheetContent
              side="right"
              showCloseButton={false}
              className="w-full gap-0 p-0 sm:max-w-md"
              // Esc stops a reply that's being written before it closes the sheet.
              onEscapeKeyDown={(e) => {
                if (!replying) return
                e.preventDefault()
                stopReply()
              }}
            >
              <SheetHeader className="sr-only">
                <SheetTitle>Brief & chat</SheetTitle>
                <SheetDescription>Research brief and chat with the AI for this email</SheetDescription>
              </SheetHeader>
              {panel}
            </SheetContent>
          </Sheet>
        )}
      </SidebarProvider>

      <CommandPalette open={palette} onOpenChange={setPalette} commands={commands} />
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
      <Toaster theme={theme} position="bottom-center" />
      </AgentProvider>
    </TooltipProvider>
  )
}
