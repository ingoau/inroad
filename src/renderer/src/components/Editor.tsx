import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { Check, Loader2, Paperclip, Trash2, X } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { hasEmail, statusAfter, type Attachment, type Comment, type Proposal, type Prospect, type Version } from '../data'
import { changeCount } from '../diff'
import { plainText } from '../markdown'
import { DiffText } from './DiffText'
import { Shortcut } from './hint'
import { RichEditor } from './RichEditor'
import type { Tab } from './RightPanel'
import type { SnippetItem } from './snippetMenu'
import { TopBar } from './TopBar'

interface Props {
  prospect: Prospect
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
  historyOpen: boolean
  onHistoryOpenChange: (open: boolean) => void
  onChange: (patch: Partial<Prospect>) => void
  onSave: () => void
  onRetry: (website: string) => void
  onStopResearch: () => void
  // Which side-column tab is showing (null when it's closed).
  panelTab: Tab | null
  onPanel: (tab: Tab) => void
  onDismissComment: (id: string) => void
  // The active chat's pending suggestions, shown in the email.
  proposals: (Proposal & { msgId: string })[]
  onProposal: (msgId: string, proposalId: string, accept: boolean) => void
  onAsk: (text: string) => void
  snippets: SnippetItem[]
  snippetScopes: { value: string; label: string }[]
  onSaveSnippet: (name: string, markdown: string, scope: string) => void
}

// Text that acts like a link: quiet until hovered.
function Quiet({ onClick, active, disabled, children, className }: { onClick?: () => void; active?: boolean; disabled?: boolean; children: ReactNode; className?: string }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn('text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50', active && 'text-foreground', className)}
    >
      {children}
    </button>
  )
}

export function Editor(props: Props) {
  const { prospect: p, queuePosition, attachments, showDiff, onToggleDiff, regenerating, onChange, onSave, onRetry } = props
  const [newTo, setNewTo] = useState('')
  const [website, setWebsite] = useState('')
  // Research-only campaigns have an email to write but no AI draft yet.
  const hasDraft = !!p.originalBody
  const editable = hasEmail(p)
  const changes = hasDraft ? changeCount(p.originalBody, p.body) : 0
  const pending = props.proposals.length

  // The AI's comments whose phrase is still in the email. Matched as plain
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

  // Suggestions for the subject show under it; the rest go inline in the body.
  const subjectProposals = props.proposals.filter((x) => p.subject.includes(x.old) && !p.body.includes(x.old))
  const inline = useMemo(
    () =>
      props.proposals
        .filter((x) => !subjectProposals.includes(x))
        .map((x, i) => ({ id: `${x.msgId}:${x.id}`, old: plainText(x.old), new: plainText(x.new), reason: x.reason, next: i === 0 })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(props.proposals), p.subject],
  )
  const resolveInline = (id: string, accept: boolean) => {
    const [msgId, propId] = id.split(':')
    props.onProposal(msgId, propId, accept)
  }
  const resolveNext = (accept: boolean) => props.proposals[0] && props.onProposal(props.proposals[0].msgId, props.proposals[0].id, accept)

  const setBody = (body: string) => onChange({ body, status: statusAfter(p, body) })

  return (
    <div className="@container flex h-full min-w-0 flex-col bg-background">
      <TopBar>
        <div className="flex-1" />
        {/* With the side column open, its own Brief / Chat tabs take over. */}
        {!props.panelTab && (
          <>
            <Quiet onClick={() => props.onPanel('brief')}>
              Brief <Shortcut keys="⌘⇧B" className="@max-md:hidden" />
            </Quiet>
            <Quiet onClick={() => props.onPanel('chat')}>
              Chat
              {pending > 0 && <span className="ml-1 text-mark-text">{pending}</span>}
              <Shortcut keys="⌘/" className="@max-md:hidden" />
            </Quiet>
          </>
        )}
        {editable && (
          <HistoryMenu
            open={props.historyOpen}
            onOpenChange={props.onHistoryOpenChange}
            versions={p.versions.filter((v) => !v.deletedAt)}
            current={p.body}
            onRestore={props.onRestoreVersion}
            onDelete={props.onDeleteVersion}
          />
        )}
      </TopBar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="relative mx-auto max-w-[600px] px-6 pt-12 pb-20">
          {p.status === 'queued' && (
            <Notice title="Waiting in the queue">{queuePosition > 0 ? `${queuePosition} ahead. Research runs 3 at a time.` : 'Starting shortly.'}</Notice>
          )}
          {p.status === 'researching' && (
            <Notice title="Researching" spinner>
              <ol className="space-y-1">
                {p.progress.slice(-6).map((step, i, all) => (
                  <li key={i} className={i === all.length - 1 ? 'text-foreground' : ''}>
                    {step}
                  </li>
                ))}
              </ol>
              <Quiet onClick={props.onStopResearch} className="mt-4">
                Stop
              </Quiet>
            </Notice>
          )}
          {p.status === 'failed' && (
            <Notice title="Research didn’t finish">
              <p className="mb-4">{p.error}</p>
              <form
                className="flex max-w-md gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  onRetry(website.trim())
                  setWebsite('')
                }}
              >
                <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder={p.domain || 'Their website (optional)'} aria-label="Website" />
                <Button type="submit" variant="secondary">
                  Retry
                </Button>
              </form>
            </Notice>
          )}

          {editable && (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                <span>To</span>
                {p.to.map((e) => (
                  <span key={e} className="group inline-flex items-center gap-1 text-foreground">
                    {e}
                    <button onClick={() => onChange({ to: p.to.filter((x) => x !== e) })} className="opacity-0 group-hover:opacity-60 hover:opacity-100!" title="Remove">
                      <X className="size-3" />
                    </button>
                  </span>
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
                  aria-label="Add a recipient"
                  placeholder={p.to.length ? '' : 'an address, or press T for the top suggestion'}
                  className="min-w-40 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/60"
                />
              </div>
              <input
                value={p.subject}
                onChange={(e) => onChange({ subject: e.target.value })}
                aria-label="Subject"
                placeholder="Subject"
                className="mt-2 mb-6 w-full bg-transparent font-heading text-2xl font-medium outline-none placeholder:text-muted-foreground/50"
              />
              {subjectProposals.map((x) => (
                <div key={x.id} className="-mt-4 mb-6 flex items-center gap-3 text-sm" title={x.reason}>
                  <span className="min-w-0 flex-1 truncate">
                    <DiffText a={p.subject} b={p.subject.replace(x.old, () => x.new)} />
                  </span>
                  <Quiet onClick={() => props.onProposal(x.msgId, x.id, true)} className="text-mark-text">
                    Accept
                  </Quiet>
                  <Quiet onClick={() => props.onProposal(x.msgId, x.id, false)}>Reject</Quiet>
                </div>
              ))}

              {showDiff ? (
                <div className="email-body whitespace-pre-wrap" style={props.bodyStyle}>
                  <DiffText a={p.originalBody} b={p.body} />
                </div>
              ) : (
                <div className={cn(regenerating && 'pointer-events-none animate-pulse opacity-40')} style={props.bodyStyle}>
                  <RichEditor
                    key={p.id}
                    value={p.body}
                    onChange={setBody}
                    highlights={highlights}
                    activeHighlight={activeComment}
                    onHighlightClick={setActiveComment}
                    suggestions={inline}
                    onSuggestion={resolveInline}
                    onAsk={props.onAsk}
                    snippets={props.snippets}
                    snippetScopes={props.snippetScopes}
                    onSaveSnippet={props.onSaveSnippet}
                  />
                </div>
              )}

              {/* Wide enough: comments sit in the margin beside their phrase. Otherwise they're listed under the email. */}
              {!showDiff && comments.length > 0 && (
                <MarginNotes
                  comments={comments}
                  body={p.body}
                  active={activeComment}
                  onActive={setActiveComment}
                  onDismiss={props.onDismissComment}
                  onAsk={(c) => props.onAsk(c.plain)}
                />
              )}

              <div className="mt-10 flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
                <Button onClick={onSave} className="h-9 rounded-full px-4">
                  {p.status === 'saved' && <Check />}
                  {p.status === 'saved' ? 'Update draft' : 'Save to Drafts'}
                  <span className="opacity-60">⌘↵</span>
                </Button>
                <Quiet onClick={props.onRegenerate} disabled={regenerating}>
                  {regenerating && <Loader2 className="mr-1 inline size-3.5 animate-spin" />}
                  {hasDraft ? (regenerating ? 'Regenerating…' : 'Regenerate') : regenerating ? 'Writing…' : 'Write with AI'}
                  <Shortcut keys="⌘R" />
                </Quiet>
                {changes > 0 && (
                  <Quiet active={showDiff} onClick={onToggleDiff}>
                    {showDiff ? 'Hide changes' : `${changes} change${changes === 1 ? '' : 's'}`}
                    <Shortcut keys="⌘D" />
                  </Quiet>
                )}
                {pending > 0 && (
                  <span className="text-muted-foreground">
                    {pending} suggestion{pending === 1 ? '' : 's'} ·{' '}
                    <Quiet onClick={() => resolveNext(true)} className="text-mark-text">
                      accept <Shortcut keys="⌘⇧↵" className="ml-0.5" />
                    </Quiet>{' '}
                    ·{' '}
                    <Quiet onClick={() => resolveNext(false)}>
                      reject <Shortcut keys="⌘⇧⌫" className="ml-0.5" />
                    </Quiet>
                  </span>
                )}
              </div>
              <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground/70">
                {attachments.map((f) => (
                  <span key={f.id} className="inline-flex items-center gap-1">
                    <Paperclip className="size-3" />
                    {f.name}
                  </span>
                ))}
                {!hasDraft && <span>No AI draft yet. Write it here, or have the AI draft it from the research.</span>}
                {changes > 0 && <span>Saving teaches {props.voiceName} from your edits.</span>}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function Notice({ title, spinner, children }: { title: string; spinner?: boolean; children: ReactNode }) {
  return (
    <div className="text-sm text-muted-foreground">
      <div className="mb-2 flex items-center gap-2 font-heading text-2xl font-medium text-foreground">
        {title}
        {spinner && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>
      {children}
    </div>
  )
}

type Placed = Comment & { plain: string }

// The AI's comments, beside the phrase each one is about. Positions come from
// the highlighted phrases in the editor, measured after every render, and are
// pushed down so notes never overlap.
function MarginNotes({
  comments,
  body,
  active,
  onActive,
  onDismiss,
  onAsk,
}: {
  comments: Placed[]
  body: string
  active: string | null
  onActive: (id: string | null) => void
  onDismiss: (id: string) => void
  onAsk: (c: Placed) => void
}) {
  const [tops, setTops] = useState<Record<string, number>>({})
  const notes = useRef<Record<string, HTMLDivElement | null>>({})
  const host = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    // Positions are relative to the email column the notes sit beside.
    const box = host.current?.parentElement
    if (!box) return
    const place = () => {
      const base = box.getBoundingClientRect().top
      const raw = comments
        .map((c) => {
          const el = box.querySelector(`[data-comment="${c.id}"]`)
          return { id: c.id, top: el ? el.getBoundingClientRect().top - base : 0 }
        })
        .sort((a, b) => a.top - b.top)
      const next: Record<string, number> = {}
      let floor = 0
      for (const r of raw) {
        const top = Math.max(r.top, floor)
        next[r.id] = top
        floor = top + (notes.current[r.id]?.offsetHeight ?? 48) + 12
      }
      setTops((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
    }
    place()
    // The editor draws the highlights after this runs, and text reflows as you
    // type, so measure again whenever either changes.
    const ro = new ResizeObserver(place)
    ro.observe(box)
    const mo = new MutationObserver(place)
    mo.observe(box, { subtree: true, childList: true, characterData: true, attributeFilter: ['data-comment'] })
    return () => {
      ro.disconnect()
      mo.disconnect()
    }
  }, [comments, body])

  const note = (c: Placed, margin: boolean) => (
    <div
      key={c.id}
      ref={margin ? (el) => void (notes.current[c.id] = el) : undefined}
      onMouseEnter={() => onActive(c.id)}
      onMouseLeave={() => onActive(null)}
      style={margin ? { top: tops[c.id] ?? 0, visibility: c.id in tops ? undefined : 'hidden' } : undefined}
      className={cn(
        'text-xs leading-relaxed text-muted-foreground transition-opacity',
        margin && 'absolute left-[calc(100%+8px)] w-52',
        active && active !== c.id && 'opacity-50',
      )}
    >
      <span className={c.kind === 'verify' ? 'text-mark-text' : 'text-foreground'}>{c.kind === 'verify' ? 'Check' : 'Note'}</span> · {c.comment}
      {!margin && <span className="text-muted-foreground/60"> “{c.plain}”</span>}
      <span className="mt-0.5 flex gap-2">
        {c.kind === 'verify' && (
          <button className="hover:text-foreground" onClick={() => onAsk(c)}>
            Ask AI
          </button>
        )}
        <button className="hover:text-foreground" onClick={() => onDismiss(c.id)}>
          Dismiss
        </button>
      </span>
    </div>
  )

  return (
    <>
      <div ref={host} className="hidden @[1100px]:block">
        {comments.map((c) => note(c, true))}
      </div>
      <div className="mt-8 grid gap-3 @[1100px]:hidden">{comments.map((c) => note(c, false))}</div>
    </>
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
  open,
  onOpenChange,
  versions,
  current,
  onRestore,
  onDelete,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  versions: Version[]
  current: string
  onRestore: (v: Version) => void
  onDelete: (v: Version) => void
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button className="text-muted-foreground transition-colors hover:text-foreground data-[state=open]:text-foreground">
          History <Shortcut keys="⌘⇧H" className="@max-md:hidden" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Restore a version. ⌘Z undoes it.</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {versions.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">Nothing yet.</p>}
        {[...versions].reverse().map((v) => {
          const isCurrent = v.markdown === current
          return (
            <DropdownMenuItem key={v.id} disabled={isCurrent} onSelect={() => onRestore(v)}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{v.label}</span>
                <span className="text-xs text-muted-foreground">
                  {v.by === 'claude' ? 'AI' : 'You'} · {ago(v.at)}
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
