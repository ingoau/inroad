import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import {
  Check,
  CircleCheck,
  Clock,
  PenLine,
  ExternalLink,
  FileText,
  GitCompare,
  History,
  Inbox,
  Loader2,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Search,
  Trash2,
  X,
  CircleAlert,
  MessageSquareText,
} from 'lucide-react'
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import type { Attachment, Prospect, SubagentRun, Version } from '../data'
import { useAgentName } from '../agent'
import { changeCount } from '../diff'
import { plainText } from '../markdown'
import { DiffText } from './DiffText'
import { ButtonKeys, Hint } from './hint'
import { RichEditor } from './RichEditor'
import type { Tab } from './RightPanel'
import { StatusBadge } from './status'

interface Props {
  prospect: Prospect
  // "Name <address>" from the mailbox settings, or '' before they're set up.
  from: string
  // CSS variables previewing Settings → Email style.
  bodyStyle: CSSProperties
  voiceName: string
  queuePosition: number
  attachments: Attachment[]
  showDiff: boolean
  onToggleDiff: () => void
  regenerating: boolean
  onRegenerate: () => void
  onRestoreVersion: (v: Version) => void
  onDeleteVersion: (v: Version) => void
  onChange: (patch: Partial<Prospect>) => void
  onSave: () => void
  onRetry: (website: string) => void
  // Which right-panel tab is showing (null when the panel is closed).
  panelTab: Tab | null
  // False when the docked panel already shows its own Brief / Chat tabs.
  showPanelButtons: boolean
  pendingSuggestions: number
  onPanel: (tab: Tab) => void
  onDismissComment: (id: string) => void
}

export function Editor(props: Props) {
  const { prospect: p, queuePosition, attachments, showDiff, onToggleDiff, regenerating, onChange, onSave, onRetry } = props
  const agent = useAgentName()
  const [newTo, setNewTo] = useState('')
  const [website, setWebsite] = useState('')
  const hasDraft = !!p.originalBody
  // Diffs compare the markdown itself, so link and formatting changes show too.
  const originalText = p.originalBody
  const bodyText = p.body
  const changes = hasDraft ? changeCount(originalText, bodyText) : 0

  // Claude's comments whose phrase is still in the email. Matched as plain
  // text, so a quote survives the markdown being written slightly differently.
  const bodyPlain = useMemo(() => plainText(p.body), [p.body])
  const comments = useMemo(
    () =>
      (p.comments ?? [])
        .filter((c) => !c.dismissed)
        .map((c) => ({ ...c, plain: plainText(c.quote) }))
        .filter((c) => c.plain && bodyPlain.includes(c.plain)),
    [p.comments, bodyPlain],
  )
  const highlights = useMemo(() => comments.map((c) => ({ id: c.id, text: c.plain, kind: c.kind, title: c.comment })), [comments])
  const [activeComment, setActiveComment] = useState<string | null>(null)
  const showComment = (id: string) => {
    setActiveComment(id)
    document.getElementById(`comment-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
  const showPhrase = (id: string) => {
    setActiveComment(id)
    document.querySelector(`[data-comment="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }

  const setBody = (body: string) =>
    onChange({
      body,
      status: p.status === 'saved' ? 'saved' : body === p.originalBody ? 'drafted' : 'edited',
    })

  return (
    <div className="@container flex h-full min-w-0 flex-col bg-background">
      <header className="drag flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Hint label="Toggle sidebar" keys="⌘ \">
          <SidebarTrigger />
        </Hint>
        <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="truncate font-heading text-base font-semibold">{p.company}</h1>
          {p.domain && (
            <a
              href={/^https?:\/\//.test(p.domain) ? p.domain : `https://${p.domain}`}
              target="_blank"
              rel="noreferrer"
              className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground @lg:inline-flex"
            >
              {p.domain} <ExternalLink className="size-3" />
            </a>
          )}
          <StatusBadge status={p.status} />
        </div>
        {props.showPanelButtons && (
          <>
            <Hint label="Brief" keys="⌘ ⇧ B">
              <Button variant={props.panelTab === 'brief' ? 'secondary' : 'ghost'} size="sm" onClick={() => props.onPanel('brief')}>
                <FileText /> <span className="@max-md:hidden">Brief</span>
              </Button>
            </Hint>
            <Hint label={`Chat with ${agent}`} keys="⌘ /">
              <Button variant={props.panelTab === 'chat' ? 'secondary' : 'ghost'} size="sm" onClick={() => props.onPanel('chat')}>
                <MessageSquare /> <span className="@max-md:hidden">Chat</span>
                {props.pendingSuggestions > 0 && <Badge className="h-4 min-w-4 bg-mark px-1 text-[10px] text-black">{props.pendingSuggestions}</Badge>}
              </Button>
            </Hint>
          </>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-8 py-6 @max-xl:px-4">
          {p.status === 'queued' && (
            <Notice icon={<Clock />} title="Waiting in queue">
              {queuePosition > 0 ? `${queuePosition} ahead. Research runs 3 at a time.` : 'Starting shortly.'}
            </Notice>
          )}
          {p.status === 'researching' && <Researching prospect={p} />}
          {p.status === 'failed' && (
            <Notice icon={<Search />} title="Research didn’t finish">
              <p className="mb-3">{p.error}</p>
              <form
                className="flex max-w-md gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  onRetry(website.trim())
                  setWebsite('')
                }}
              >
                <Input
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder={p.domain || 'Their website (optional)'}
                  aria-label="Website"
                  className="bg-background"
                />
                <Button type="submit">
                  <RefreshCw /> Retry
                </Button>
              </form>
            </Notice>
          )}

          {hasDraft && (
            <>
              <div className="text-sm">
                <Field label="From">
                  <span className="truncate text-muted-foreground">{props.from || 'Set up your mailbox in Settings'}</span>
                  <Badge variant="outline" className="ml-auto shrink-0 font-normal text-muted-foreground">
                    <PenLine className="size-3" /> {props.voiceName}
                  </Badge>
                </Field>
                <Field label="To">
                  <div className="flex flex-1 flex-wrap items-center gap-1.5">
                    {p.to.map((e) => (
                      <Badge key={e} variant="secondary" className="gap-1 pr-1 font-normal">
                        {e}
                        <button
                          onClick={() => onChange({ to: p.to.filter((x) => x !== e) })}
                          className="rounded-sm opacity-60 hover:opacity-100"
                          title="Remove"
                        >
                          <X className="size-3" />
                        </button>
                      </Badge>
                    ))}
                    <input
                      value={newTo}
                      onChange={(e) => setNewTo(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && newTo.trim()) {
                          onChange({ to: [...p.to, newTo.trim()] })
                          setNewTo('')
                        }
                      }}
                      placeholder={p.to.length ? '' : 'Type an address, or press T to add the top suggestion'}
                      className="min-w-40 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                    />
                  </div>
                </Field>
                <Field label="Subject">
                  <input value={p.subject} onChange={(e) => onChange({ subject: e.target.value })} className="flex-1 bg-transparent font-medium outline-none" />
                </Field>
              </div>

              {showDiff ? (
                <div className="email-body py-5 whitespace-pre-wrap">
                  <DiffText a={originalText} b={bodyText} />
                </div>
              ) : (
                <div className={cn(regenerating && 'pointer-events-none animate-pulse opacity-40')} style={props.bodyStyle}>
                  <RichEditor
                    key={p.id}
                    value={p.body}
                    onChange={setBody}
                    highlights={highlights}
                    activeHighlight={activeComment}
                    onHighlightClick={showComment}
                  />
                </div>
              )}

              {comments.length > 0 && !showDiff && (
                <div className="mt-5 grid gap-1.5" onMouseLeave={() => setActiveComment(null)}>
                  {comments.map((c) => (
                    <div
                      key={c.id}
                      id={`comment-${c.id}`}
                      onMouseEnter={() => setActiveComment(c.id)}
                      onClick={() => showPhrase(c.id)}
                      className={cn(
                        'group flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors',
                        activeComment === c.id ? 'border-mark/60 bg-mark/10' : 'hover:bg-muted/40',
                      )}
                    >
                      {c.kind === 'verify' ? (
                        <CircleAlert className="mt-0.5 size-4 shrink-0 text-mark" aria-label="Check this" />
                      ) : (
                        <MessageSquareText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-label="Note" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs text-muted-foreground">
                          {c.kind === 'verify' ? 'Check' : 'Note'} · “{c.plain}”
                        </div>
                        <div className="leading-snug">{c.comment}</div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        title="Dismiss"
                        className="text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation()
                          props.onDismissComment(c.id)
                        }}
                      >
                        <X />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <Separator className="mt-6 mb-3" />
              <div className="flex flex-wrap items-center gap-2">
                {attachments.map((f) => (
                  <Badge key={f.id} variant="outline" className="gap-1.5 font-normal">
                    <Paperclip className="size-3" />
                    {f.name}
                  </Badge>
                ))}
                <span className="text-xs text-muted-foreground">
                  {changes > 0
                    ? `${changes} change${changes === 1 ? '' : 's'} from ${agent}’s draft. Saving teaches your voice profile from them.`
                    : `${agent}’s draft, unedited.`}
                </span>
              </div>
            </>
          )}
        </div>
      </div>

      {hasDraft && (
        <footer className="flex h-12 shrink-0 items-center gap-1 border-t px-3">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <HistoryMenu
              versions={p.versions.filter((v) => !v.deletedAt)}
              current={p.body}
              onRestore={props.onRestoreVersion}
              onDelete={props.onDeleteVersion}
            />
            <Hint label="Write a fresh draft from the same brief" keys="⌘ R" side="top">
              <Button variant="ghost" size="sm" onClick={props.onRegenerate} disabled={regenerating}>
                <RefreshCw className={cn(regenerating && 'animate-spin')} />
                <span className="@max-md:hidden">{regenerating ? 'Regenerating…' : 'Regenerate'}</span>
              </Button>
            </Hint>
            <Hint label={`Compare with ${agent}’s draft`} keys="⌘ D" side="top">
              <Button variant={showDiff ? 'secondary' : 'ghost'} size="sm" onClick={onToggleDiff} disabled={changes === 0}>
                <GitCompare /> <span className="@max-md:hidden">Changes</span>
                {changes > 0 && <span className="text-muted-foreground">{changes}</span>}
              </Button>
            </Hint>
          </div>
          <Button size="sm" onClick={onSave}>
            {p.status === 'saved' ? <Check /> : <Inbox />}
            {p.status === 'saved' ? 'Update draft' : 'Save to drafts'}
            <ButtonKeys keys="⌘ ↵" primary className="@max-md:hidden" />
          </Button>
        </footer>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-center gap-3 border-b py-1">
      <span className="w-14 shrink-0 text-xs text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

function Notice({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground [&>svg]:mt-0.5 [&>svg]:size-4 [&>svg]:shrink-0">
      {icon}
      <div className="min-w-0 flex-1">
        <div className="mb-1 font-medium text-foreground">{title}</div>
        {children}
      </div>
    </div>
  )
}

function Researching({ prospect: p }: { prospect: Prospect }) {
  const runs = p.subagents ?? []
  return (
    <Notice icon={<Loader2 className="animate-spin" />} title="Researching">
      {runs.length > 0 && (
        <div className="mb-3 grid gap-2 @md:grid-cols-3">
          {runs.map((run, i) => (
            <SubagentColumn key={i} run={run} />
          ))}
        </div>
      )}
      <ol className="space-y-1">
        {p.progress.map((step, i) => (
          <li key={i} className={i === p.progress.length - 1 ? 'text-foreground' : ''}>
            {step}
          </li>
        ))}
      </ol>
    </Notice>
  )
}

// One fan-out sub-agent's live activity, one column of the side-by-side grid.
function SubagentColumn({ run }: { run: SubagentRun }) {
  const failed = run.done && run.steps.at(-1)?.startsWith('Failed — ')
  return (
    <div className={cn('min-w-0 rounded-lg border bg-background/60 p-2.5 text-xs', run.done && 'opacity-75')}>
      <div className="mb-1.5 flex items-center gap-1.5 font-medium text-foreground">
        {!run.done ? (
          <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
        ) : failed ? (
          <CircleAlert className="size-3 shrink-0 text-destructive" />
        ) : (
          <CircleCheck className="size-3 shrink-0 text-success" />
        )}
        <span className="truncate">{run.label || 'Sub-agent'}</span>
      </div>
      <ul className="max-h-44 space-y-0.5 overflow-y-auto text-muted-foreground">
        {run.steps.map((s, i) => (
          <li key={i} className={i === run.steps.length - 1 && !run.done ? 'text-foreground' : ''}>
            {s}
          </li>
        ))}
      </ul>
    </div>
  )
}

function ago(at: number) {
  const m = Math.round((Date.now() - at) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

function HistoryMenu({
  versions,
  current,
  onRestore,
  onDelete,
}: {
  versions: Version[]
  current: string
  onRestore: (v: Version) => void
  onDelete: (v: Version) => void
}) {
  const agent = useAgentName()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm">
          <History /> <span className="@max-md:hidden">History</span> <span className="text-muted-foreground">{versions.length}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Restore a version. ⌘Z undoes it.</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {[...versions].reverse().map((v) => {
          const isCurrent = v.markdown === current
          return (
            <DropdownMenuItem key={v.id} disabled={isCurrent} onSelect={() => onRestore(v)}>
              <span className={cn('size-1.5 shrink-0 rounded-full', v.by === 'claude' ? 'bg-primary' : 'bg-success')} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{v.label}</span>
                <span className="text-xs text-muted-foreground">
                  {v.by === 'claude' ? agent : 'You'} · {ago(v.at)}
                </span>
              </span>
              {isCurrent ? (
                <span className="text-xs text-muted-foreground">Current</span>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  title="Delete this version"
                  className="text-muted-foreground hover:text-destructive"
                  // Don't also trigger the item's "restore".
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onDelete(v)
                  }}
                >
                  <Trash2 />
                </Button>
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
