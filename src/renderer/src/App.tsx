import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import {
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
  Settings,
  Sun,
  Trash2,
  Undo2,
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { usePanelRef } from 'react-resizable-panels'
import { toast } from 'sonner'
import { AgentProvider, agentName } from './agent'
import { notifyDesktop, syncDesktopNotify } from './desktopNotify'
import { CommandPalette, ShortcutsDialog, type PaletteCommand } from './components/CommandPalette'
import { AddCompaniesDialog } from './components/AddCompaniesDialog'
import { AgentQuestions } from './components/AgentQuestions'
import { Editor } from './components/Editor'
import { activeChat, RightPanel, type Tab } from './components/RightPanel'
import type { TrashItem } from './components/TrashView'
import { SettingsSidebar, type SettingsPage } from './components/settings/SettingsSidebar'
import { SettingsView } from './components/settings/SettingsView'
import { AppSidebar, inFilter, type Filter } from './components/Sidebar'
import { statusStyle } from './components/status'
import { useBreakpoint } from './layout'
import {
  MAX_VOICE_EXAMPLES,
  type Attachment,
  type Campaign,
  type ChatMsg,
  type Comment,
  type Folder,
  type ChatThread,
  type Prospect,
  type Version,
  type Voice,
  type VoiceExample,
} from './data'
import type { ClaudeProgress, DraftRef, EmailComment, PublicSettings, VoiceInput } from '../../shared/api'
import { firstRun, persist, upgrade, type SavedState } from './persist'
import { defaultEmailStyle, emailHtml, emailStyleVars, markdownToText, normalizeMarkdown, type EmailStyle } from './markdown'
import { Onboarding, type OnboardingResult } from './components/Onboarding'
import { currentEditor, historyDepth, undoBridge, type UndoEntry } from './undo'

const MAX_CONCURRENT = 3
// How long a save is held back before it touches the mailbox; undoing inside
// this window cancels it rather than having to delete the draft.
const UNDO_GRACE_MS = 5000
type Theme = 'dark' | 'light'

const needsReview = (p: Prospect) => p.status === 'drafted' || p.status === 'edited'
// Claude's comments, stamped for storing on a prospect.
const stamp = (comments: EmailComment[], by: Comment['by']): Comment[] => comments.map((c) => ({ ...c, id: crypto.randomUUID(), by, at: Date.now() }))

const hasText = (p: Prospect | undefined, text: string) => !!p && !!text && (p.subject.includes(text) || p.body.includes(text))
const statusAfter = (p: Prospect, body: string): Prospect['status'] => (p.status === 'saved' ? 'saved' : body !== p.originalBody ? 'edited' : 'drafted')

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
  // The email workspace, or Settings (which swaps in its own sidebar).
  const [view, setView] = useState<'email' | 'settings'>('email')
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
    persist({ version: 1, prospects, folders, campaigns, voices, campaignId, selectedId, onboarded, emailStyle })
  }, [prospects, folders, campaigns, voices, campaignId, selectedId, onboarded, emailStyle])
  const [tab, setTab] = useState<Tab>('chat')
  const [filter, setFilter] = useState<Filter>('all')
  const [showDiff, setShowDiff] = useState(false)
  const [adding, setAdding] = useState(false)
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const [theme, setTheme] = useState<Theme>(loadTheme)
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null)
  // Mailbox & API key settings (secrets stay in the main process).
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  // Name of the chosen AI backend, used in copy throughout the app.
  const agent = agentName(settings?.aiProvider)
  const openSettings = (page: SettingsPage = settingsPage) => {
    setSettingsPage(page)
    setView('settings')
  }
  const closeSettings = () => setView('email')
  useEffect(() => {
    window.api?.settings.get().then(setSettings)
  }, [])

  // Desktop notifications follow the saved setting wherever it changes.
  useEffect(() => {
    syncDesktopNotify(!!settings?.desktopNotifications)
  }, [settings?.desktopNotifications])

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
  const shown = inCampaign.filter((p) => inFilter[filter](p.status))
  const update = (id: string, fn: (p: Prospect) => Prospect) => setProspects((ps) => ps.map((p) => (p.id === id ? fn(p) : p)))
  const overlayOpen = adding || palette || help || (!rightDocks && rightOpen)
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
  const claudeContext = (p: Prospect) => {
    const c = campaignsRef.current.find((c) => c.id === p.campaignId)
    // Claude should know what's attached so the email can mention it.
    const files = c?.attachments.length ? `\n\nAttached to every email: ${c.attachments.map((a) => a.name).join(', ')}` : ''
    // The folder's shared context comes first, then this campaign's own notes.
    const f = foldersRef.current.find((f) => f.id === c?.folderId)
    const about = f && (f.name || f.notes) ? `About ${f.name || 'the event'} (shared by every campaign in it):\n${f.notes}\n\nThis campaign:\n` : ''
    return {
      company: p.company,
      campaignNotes: about + (c?.notes ?? '') + files,
      emailFormat: c?.format,
      orgNote: p.note,
      voice: voiceInput(voiceOf(p.campaignId)),
      senderName: settingsRef.current?.mail?.fromName ?? '',
    }
  }

  // Research runner: pulls from the queue so at most MAX_CONCURRENT run at once.
  const researching = useRef(new Set<string>())
  const research = async (p: Prospect) => {
    const pid = p.id
    researching.current.add(pid)
    update(pid, (q) => ({ ...q, status: 'researching', progress: [], subagents: [], error: undefined }))
    const jobId = crypto.randomUUID()
    jobs.current.set(jobId, (e) => {
      if (e.kind === 'step') update(pid, (q) => ({ ...q, progress: [...q.progress, e.text] }))
      else if (e.kind === 'subagent')
        update(pid, (q) => {
          const runs = [...(q.subagents ?? [])]
          while (runs.length <= e.subagent) runs.push({ label: '', steps: [] })
          const run = runs[e.subagent]
          runs[e.subagent] = { ...run, label: e.label, done: e.done, steps: [...run.steps, e.text] }
          return { ...q, subagents: runs }
        })
    })
    const res = window.api
      ? await window.api.claude.research({ jobId, website: p.domain || undefined, ...claudeContext(p) })
      : ({ ok: false, error: 'Research runs in the Inroad desktop app.' } as const)
    jobs.current.delete(jobId)
    researching.current.delete(pid)
    if (!res.ok) {
      update(pid, (q) => ({ ...q, status: 'failed', error: res.error }))
      notifyDesktop(`Research failed: ${p.company}`, res.error)
      return
    }
    const { research, draft } = res.value
    const md = normalizeMarkdown(draft.body)
    update(pid, (q) => ({
      ...q,
      status: 'drafted',
      research,
      brief: draft.brief,
      subject: draft.subject,
      body: md,
      originalBody: md,
      to: draft.to ? [draft.to] : [],
      versions: [...q.versions, { id: crypto.randomUUID(), label: `${agent}’s draft`, by: 'claude', at: Date.now(), markdown: md }],
      comments: [...(q.comments ?? []), ...stamp(draft.comments, 'draft')],
    }))
    notifyDesktop(`Draft ready: ${p.company}`, draft.subject)
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
    const next = i < 0 ? 0 : Math.min(Math.max(i + delta, 0), shown.length - 1)
    select(shown[next].id)
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
    const first = list.find(needsReview) ?? list[0]
    if (first) select(first.id)
  }

  const updateCampaign = (id: string, patch: Partial<Campaign>) => setCampaigns((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))

  // New campaigns go in the open campaign's folder unless told otherwise.
  const createCampaign = (folderId = campaign.folderId) => {
    const id = crypto.randomUUID()
    setCampaigns((cs) => [...cs, { id, folderId, name: '', notes: '', attachments: [], voiceId: campaign.voiceId }])
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

  const deleteVersion = (v: Version) => {
    if (!selected) return
    const pid = selected.id
    softDelete(`“${v.label}”`, (at) => setVersionDeleted(pid, v.id, at), pid)
  }

  // ---- Chats: several per email ----
  const selectChat = (chatId: string) => selected && update(selected.id, (p) => ({ ...p, activeChatId: chatId }))

  const newChat = () => {
    if (!selected?.originalBody) return
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
    if (!selected?.originalBody) return
    if (!mailReady)
      return notify({ text: 'Connect your mailbox to save drafts', action: { label: 'Open settings', run: () => openSettings({ kind: 'mailbox' }) } })
    const { id: pid, status: prev, company, draftRef: prevRef } = selected
    const edited = selected.body !== selected.originalBody
    const versionId = crypto.randomUUID()
    // This save's trip to the mailbox, so undo knows whether to cancel it or delete the draft.
    const sync: { committed: boolean; ref?: DraftRef } = { committed: false }
    // Voice learning runs alongside; undo rolls it back, redo re-applies it.
    const learn: { started: boolean; active: boolean; change?: VoiceChange } = { started: false, active: false }
    const snapshot = selected

    const commit = async () => {
      sync.committed = true
      const p = get(pid)
      if (!p || !window.api) return
      const attachments = campaignsRef.current.find((c) => c.id === p.campaignId)?.attachments ?? []
      const res = await window.api.mail.saveDraft({
        to: p.to,
        subject: p.subject,
        html: emailHtml(p.body, emailStyleRef.current),
        text: markdownToText(p.body),
        attachments,
      })
      if (!res.ok) {
        update(pid, (q) => ({ ...q, status: prev === 'saved' ? 'edited' : prev, versions: q.versions.filter((v) => v.id !== versionId) }))
        return notify({
          text: `Couldn’t save ${company} to Drafts: ${res.error}`,
          action: { label: 'Open settings', run: () => openSettings({ kind: 'mailbox' }) },
        })
      }
      sync.ref = res.value
      update(pid, (q) => ({ ...q, draftRef: res.value }))
      // Saving again replaces the earlier draft rather than leaving a duplicate behind.
      if (prevRef) void window.api.mail.deleteDraft(prevRef)
    }

    const apply = () => {
      update(pid, (p) => ({
        ...p,
        status: 'saved',
        versions: [...p.versions, { id: versionId, label: 'Saved to Drafts', by: 'you', at: Date.now(), markdown: p.body }],
      }))
      // Held back briefly so undo can cancel it before anything reaches the mailbox.
      sync.committed = false
      clearTimeout(commitTimers.current[pid])
      commitTimers.current[pid] = window.setTimeout(commit, UNDO_GRACE_MS)
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
        update(pid, (p) => ({ ...p, status: prev, draftRef: prevRef, versions: p.versions.filter((v) => v.id !== versionId) }))
        learn.active = false
        if (learn.change) applyVoiceChange(learn.change, false)
        if (!sync.committed) {
          clearTimeout(commitTimers.current[pid])
          return `Cancelled saving ${company}. Nothing reached your mailbox.`
        }
        if (sync.ref && window.api)
          void window.api.mail.deleteDraft(sync.ref).then((r) => !r.ok && notify({ text: `Couldn’t remove the draft from your mailbox: ${r.error}` }))
        return `Deleted ${company}'s draft from your mailbox${learn.change ? ' and rolled back the voice update' : ''}`
      },
      apply,
      `Saved ${company} to Drafts${nextName ? ` · now on ${nextName}` : ''}`,
    )
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  const regenerate = async () => {
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
        status: x.status === 'saved' ? 'saved' : 'drafted',
        versions: [...x.versions.filter((v) => !added.some((a) => a.id === v.id)), ...added],
        // The new draft's comments replace the old draft's; ones from chat stay.
        comments: [...(x.comments ?? []).filter((c) => c.by !== 'draft' && !fresh.some((f) => f.id === c.id)), ...fresh],
      }))
    apply()
    record(
      'Regenerated draft',
      pid,
      () => {
        update(pid, (x) => ({ ...x, ...before }))
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
  const swapText = (pid: string, from: string, to: string) =>
    update(pid, (p) => {
      if (p.subject.includes(from)) return { ...p, subject: p.subject.replace(from, () => to) }
      // Re-normalise so the stored text matches what the editor would write.
      const body = normalizeMarkdown(p.body.replace(from, () => to))
      return { ...p, body, status: statusAfter(p, body) }
    })

  const resolveProposal = (msgId: string, propId: string, accept: boolean) => {
    if (!selected) return
    const pid = selected.id
    const prop = findProposal(selected, msgId, propId)
    if (!prop) return
    if (accept && !hasText(selected, prop.old)) return notify({ text: `Couldn't apply: that text has changed since ${agent} suggested it` })
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
        if (pr.state === 'pending') {
          setTab('chat')
          return resolveProposal(m.id, pr.id, accept)
        }
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
    if (!selected?.originalBody) return
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

  const toggleChatFocus = () => {
    if (document.activeElement?.id === 'chat-input' && selected?.originalBody) editBody()
    else openChat()
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
      // Dialogs and sheets handle their own Escape; don't act behind them.
      if (overlayOpen) return
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

      // Modifier shortcuts work everywhere, including mid-typing, since most of
      // the time focus is in the email or the chat box.
      if (mod) {
        const key = e.key.toLowerCase()
        const run = (fn: () => void) => {
          e.preventDefault()
          fn()
        }
        if (key === ',') return run(() => openSettings())
        if (key === 'enter') return run(e.shiftKey ? () => resolveNextProposal(true) : save)
        if (key === 'backspace' && e.shiftKey) return run(() => resolveNextProposal(false))
        if (key === '/') return run(toggleChatFocus)
        if (key === 'b' && e.shiftKey) return run(() => togglePanel('brief'))
        // ⌘\\ (left sidebar) is handled by shadcn's SidebarProvider.
        if ((key === '\\' || key === '|') && e.shiftKey) return run(() => setRightOpen((v) => !v))
        if (key === ']') return run(() => step(1))
        if (key === '[') return run(() => step(-1))
        if (key === 'd' && !e.shiftKey) return run(() => setShowDiff((v) => !v))
        if (key === 'r' && !e.shiftKey) return run(regenerate)
      }
      if (typing || mod || e.altKey) return

      const actions: Record<string, () => void> = {
        j: () => step(1),
        ArrowDown: () => step(1),
        k: () => step(-1),
        ArrowUp: () => step(-1),
        n: goToNextReview,
        '1': () => setFilter('all'),
        '2': () => setFilter('review'),
        '3': () => setFilter('saved'),
        e: editBody,
        Enter: editBody,
        t: addTopRecipient,
        b: () => togglePanel('brief'),
        '/': openChat,
        a: () => resolveNextProposal(true),
        x: () => resolveNextProposal(false),
        c: () => setAdding(true),
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
      icon: <span className="grid size-4 place-items-center rounded-sm bg-muted text-[10px] font-semibold">{p.company[0]}</span>,
      hint: statusStyle[p.status].label,
      run: () => select(p.id),
    })),
    ...(undoTop ? [{ id: 'undo', group: 'Actions' as const, label: `Undo: ${undoTop.label}`, icon: <Undo2 />, shortcut: '⌘Z', run: appUndo }] : []),
    ...(redoTop ? [{ id: 'redo', group: 'Actions' as const, label: `Redo: ${redoTop.label}`, icon: <Redo2 />, shortcut: '⌘⇧Z', run: appRedo }] : []),
    { id: 'save', group: 'Actions', label: 'Save to drafts', icon: <Inbox />, shortcut: '⌘↵', run: save },
    { id: 'diff', group: 'Actions', label: `Compare with ${agent}’s draft`, icon: <GitCompare />, shortcut: '⌘D', run: () => setShowDiff((v) => !v) },
    { id: 'regen', group: 'Actions', label: 'Regenerate draft', icon: <RefreshCw />, shortcut: '⌘R', run: regenerate },
    { id: 'chat', group: 'Actions', label: `Chat with ${agent}`, icon: <MessageSquare />, shortcut: '⌘/', run: openChat },
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
    { id: 'add', group: 'Actions', label: 'Add to campaign', icon: <Plus />, shortcut: 'C', run: () => setAdding(true) },
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

  const addProspects = (orgs: { name: string; website: string; note: string }[]) => {
    const added = orgs.map<Prospect>(({ name, website, note }) => ({
      id: crypto.randomUUID(),
      campaignId,
      company: name,
      domain: website,
      note: note || undefined,
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
    record(`Added ${added.length} to ${campaign.name}`, undefined, () => setProspects((ps) => ps.filter((p) => !ids.includes(p.id))), apply)
    setAdding(false)
  }

  // A suggestion as Claude will see it in the transcript of earlier turns.
  const describe = (m: ChatMsg) =>
    [
      m.text,
      ...(m.proposals ?? []).map((x) => `[Suggested replacing “${x.old}” with “${x.new}” — ${x.state === 'pending' ? 'not yet decided' : x.state}]`),
    ].join('\n')

  const sendChat = async (text: string) => {
    if (!selected) return
    const p = selected
    const pid = p.id
    const current = activeChat(p)
    if (current?.messages.some((m) => m.pending)) return
    // No chat yet: start one, named after the first message.
    const thread: ChatThread = current ?? { id: crypto.randomUUID(), title: text.slice(0, 40), createdAt: Date.now(), messages: [] }
    const chatId = thread.id
    const title = thread.messages.length ? thread.title : text.slice(0, 40)
    const history = thread.messages.filter((m) => !m.error).map((m) => ({ role: m.role, text: describe(m) }))
    const replyId = crypto.randomUUID()
    const userMsg: ChatMsg = { id: crypto.randomUUID(), role: 'user', text }
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
    jobs.current.set(jobId, (e) => e.kind === 'delta' && setReply((m) => ({ ...m, text: m.text + e.text })))
    const res = await window.api.claude.chat({
      jobId,
      ...claudeContext(p),
      brief: p.brief,
      subject: p.subject,
      body: p.body,
      comments: (p.comments ?? []).filter((c) => !c.dismissed).map(({ quote, comment, kind }) => ({ quote, comment, kind })),
      history,
      message: text,
    })
    jobs.current.delete(jobId)
    if (!res.ok) return setReply((m) => ({ ...m, pending: false, error: true, text: res.error }))
    setReply((m) => ({
      ...m,
      pending: false,
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
    setAdding(true)
  }

  const startFresh = () => {
    const fresh = firstRun()
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
      onRevertProposal={revertProposal}
      onSend={sendChat}
      onNewChat={newChat}
      onSelectChat={selectChat}
      onDeleteChat={deleteChat}
    />
  )

  const main = selected ? (
    <Editor
      prospect={selected}
      bodyStyle={emailStyleVars(emailStyle) as CSSProperties}
      from={settings?.mail?.fromEmail ? `${settings.mail.fromName ? `${settings.mail.fromName} ` : ''}<${settings.mail.fromEmail}>` : ''}
      voiceName={voice.name}
      attachments={campaign.attachments}
      queuePosition={queuePosition}
      showDiff={showDiff}
      onToggleDiff={() => setShowDiff((v) => !v)}
      regenerating={regeneratingId === selected.id}
      onRegenerate={regenerate}
      onRestoreVersion={restoreVersion}
      onDeleteVersion={deleteVersion}
      onChange={(patch) => (patch.to ? setRecipients(patch.to) : update(selected.id, (p) => ({ ...p, ...patch })))}
      onRetry={(website) => update(selected.id, (p) => ({ ...p, status: 'queued', progress: [], subagents: [], error: undefined, domain: website || p.domain }))}
      onSave={save}
      panelTab={rightOpen ? tab : null}
      showPanelButtons={!(rightDocks && rightOpen)}
      pendingSuggestions={(activeChat(selected)?.messages ?? []).flatMap((m) => m.proposals ?? []).filter((x) => x.state === 'pending').length}
      onPanel={togglePanel}
      onDismissComment={dismissComment}
    />
  ) : (
    <div className="flex h-full flex-col items-start justify-center gap-3 px-10">
      <h2 className="font-heading text-2xl font-semibold">Nothing in {campaign.name || 'this campaign'} yet</h2>
      <p className="max-w-md text-muted-foreground">
        {campaign.notes.trim()
          ? `Add the organisations you want to reach. ${agent} researches each one and drafts an email.`
          : `Start with the campaign notes: what you’re asking for, the details ${agent} should mention, and what to look for when researching. Then add the organisations you want to reach.`}
      </p>
      <div className="flex gap-2">
        {!campaign.notes.trim() && (
          <Button onClick={() => openSettings({ kind: 'campaign', id: campaign.id })}>
            <Flag /> Write campaign notes
          </Button>
        )}
        <Button variant={campaign.notes.trim() ? 'default' : 'outline'} onClick={() => setAdding(true)}>
          <Plus /> Add to campaign
        </Button>
      </div>
    </div>
  )

  if (!onboarded)
    return (
      <TooltipProvider delayDuration={300}>
        <AgentProvider provider={settings?.aiProvider}>
          <Onboarding onFinish={finishOnboarding} onSkip={() => setOnboarded(true)} settings={settings} onSettings={setSettings} />
          <AgentQuestions />
        </AgentProvider>
        <Toaster theme={theme} position="bottom-center" />
      </TooltipProvider>
    )

  return (
    <TooltipProvider delayDuration={300}>
      <AgentProvider provider={settings?.aiProvider}>
      <SidebarProvider open={leftOpen} onOpenChange={setLeftOpen} className="h-svh min-h-0 overflow-hidden">
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
              />
            </SidebarInset>
          </>
        ) : (
          <>
            <AppSidebar
              prospects={inCampaign}
              allProspects={prospects.filter((p) => !p.deletedAt)}
              campaigns={aliveCampaigns}
              campaignId={campaign.id}
              voices={aliveVoices}
              onDeleteProspect={deleteProspect}
              onDeleteCampaign={deleteCampaign}
              trashCount={trash.length}
              onOpenTrash={() => openSettings({ kind: 'trash' })}
              mailAddress={mailReady ? settings?.mail?.fromEmail : undefined}
              onOpenSettings={() => openSettings()}
              onSwitchCampaign={switchCampaign}
              onEditCampaign={(id) => openSettings({ kind: 'campaign', id })}
              onNewCampaign={() => openSettings({ kind: 'campaign', id: createCampaign() })}
              folders={aliveFolders}
              onEditFolder={(id) => openSettings({ kind: 'folder', id })}
              onNewFolder={() => openSettings({ kind: 'folder', id: createFolder() })}
              onSetVoice={setVoice}
              onEditVoices={editVoices}
              selectedId={selectedId}
              onSelect={select}
              onAdd={() => setAdding(true)}
              filter={filter}
              onFilter={setFilter}
              theme={theme}
              onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              onOpenPalette={() => setPalette(true)}
              onShowKeys={() => setHelp(true)}
            />
            <SidebarInset className="min-w-0 overflow-hidden">
              {rightDocks && selected && view === 'email' ? (
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
                  <ResizableHandle />
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
          <Sheet open={rightOpen && !!selected && view === 'email'} onOpenChange={setRightOpen}>
            <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-md">
              <SheetHeader className="sr-only">
                <SheetTitle>Brief & chat</SheetTitle>
                <SheetDescription>Research brief and chat with {agent} for this email</SheetDescription>
              </SheetHeader>
              {panel}
            </SheetContent>
          </Sheet>
        )}
      </SidebarProvider>

      <AddCompaniesDialog
        open={adding}
        onOpenChange={setAdding}
        campaign={campaign}
        voiceName={voice.name}
        eventInfo={folder.notes}
        existing={inCampaign.map((p) => p.company)}
        onAdd={addProspects}
      />
      <CommandPalette open={palette} onOpenChange={setPalette} commands={commands} />
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
      <AgentQuestions />
      <Toaster theme={theme} position="bottom-center" />
      </AgentProvider>
    </TooltipProvider>
  )
}
