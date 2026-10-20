import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import Markdown from 'react-markdown'
import { Loader2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { hasEmail, type ChatMsg, type ChatThread, type Proposal, type Prospect } from '../data'
import { plainText } from '../markdown'
import { Shortcut } from './hint'

export type Tab = 'brief' | 'chat'

interface Props {
  prospect: Prospect
  tab: Tab
  onTab: (t: Tab) => void
  onClose: () => void
  onAddRecipient: (email: string) => void
  onNote: (note: string) => void
  onProposal: (msgId: string, proposalId: string, accept: boolean) => void
  // Accept or reject every pending suggestion in one reply.
  onProposalsAll: (msgId: string, accept: boolean) => void
  onRevertProposal: (msgId: string, proposalId: string) => void
  onSend: (text: string) => void
  // Stops the reply being written.
  onStop: () => void
  // A passage of the email to ask about, attached to the next message.
  quote: string | null
  onClearQuote: () => void
  onNewChat: () => void
  onSelectChat: (id: string) => void
  onDeleteChat: (id: string) => void
}

// The thread the chat panel shows: the selected one if it still exists, else the newest.
export function activeChat(p: Prospect): ChatThread | undefined {
  const alive = p.chats.filter((c) => !c.deletedAt)
  return alive.find((c) => c.id === p.activeChatId) ?? alive.at(-1)
}

// Text that acts like a link: quiet until hovered.
function Quiet({ onClick, active, title, children, className }: { onClick?: () => void; active?: boolean; title?: string; children: ReactNode; className?: string }) {
  return (
    <button onClick={onClick} title={title} className={cn('text-muted-foreground transition-colors hover:text-foreground', active && 'text-foreground', className)}>
      {children}
    </button>
  )
}

// A borderless column beside the email: the brief or the chat, never both.
export function RightPanel(props: Props) {
  const { prospect: p, tab, onClose } = props
  // Clicking the tab that's already showing closes the column, like the links in the email's top bar.
  const onTab = (t: Tab) => (t === tab ? onClose() : props.onTab(t))
  const thread = activeChat(p)
  const threads = p.chats.filter((c) => !c.deletedAt)
  return (
    <div id="side-panel" className="@container/panel flex h-full min-w-0 flex-col bg-background text-sm">
      <div className="drag flex h-12 shrink-0 items-center gap-5 px-6 whitespace-nowrap">
        <Quiet active={tab === 'brief'} onClick={() => onTab('brief')} title={tab === 'brief' ? 'Hide' : undefined} className={cn(tab === 'brief' && 'shadow-[inset_0_-1px_0_currentColor]')}>
          Brief <Shortcut keys="⌘⇧B" className="hidden @xs/panel:inline" />
        </Quiet>
        <Quiet active={tab === 'chat'} onClick={() => onTab('chat')} title={tab === 'chat' ? 'Hide' : undefined} className={cn(tab === 'chat' && 'shadow-[inset_0_-1px_0_currentColor]')}>
          Chat <Shortcut keys="⌘/" className="hidden @xs/panel:inline" />
        </Quiet>
        <div className="flex-1" />
        {tab === 'chat' && hasEmail(p) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="max-w-40 truncate text-muted-foreground hover:text-foreground">{thread?.title ?? 'New chat'} ⌄</button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {threads.length > 0 && (
                <>
                  <DropdownMenuRadioGroup value={thread?.id} onValueChange={props.onSelectChat}>
                    {[...threads].reverse().map((c) => (
                      <DropdownMenuRadioItem key={c.id} value={c.id}>
                        <span className="truncate">{c.title}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem onSelect={props.onNewChat}>
                New chat <Shortcut keys="⌘N" className="ml-auto" />
              </DropdownMenuItem>
              {thread && (
                <DropdownMenuItem variant="destructive" onSelect={() => props.onDeleteChat(thread.id)}>
                  Delete this chat
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {tab === 'brief' ? <BriefView prospect={p} onAddRecipient={props.onAddRecipient} onNote={props.onNote} /> : <ChatView {...props} />}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-xs text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function BriefView({ prospect: p, onAddRecipient, onNote }: { prospect: Prospect; onAddRecipient: (e: string) => void; onNote: (note: string) => void }) {
  const b = p.brief
  // Sources come from the model, so don't trust them to be valid URLs.
  const hostname = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return url
    }
  }
  const confidence = { high: 'high', medium: 'medium', low: 'guessed' }
  // Your instructions for this organisation, editable any time.
  const note = (
    <Section title="Your note">
      <textarea
        value={p.note ?? ''}
        onChange={(e) => onNote(e.target.value)}
        rows={2}
        placeholder={`Anything the AI should say or look for with ${p.company}`}
        className="field-sizing-content w-full resize-none bg-transparent leading-relaxed outline-none placeholder:text-muted-foreground/60"
      />
      {p.note?.trim() && hasEmail(p) && <p className="text-xs text-muted-foreground/70">Regenerate (⌘R) or ask in chat to apply it.</p>}
    </Section>
  )
  if (!b)
    return (
      <div className="space-y-6 px-6 py-4 leading-relaxed">
        <p className="text-muted-foreground">The brief appears here once {p.company} has been researched.</p>
        {note}
      </div>
    )

  return (
    <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
      <div className="space-y-6 px-6 py-4 leading-relaxed">
        <Section title={p.company}>
          <p>{b.summary}</p>
        </Section>
        <Section title="Write to">
          <div className="space-y-1.5">
            {b.recipients.map((r) => {
              const added = !!r.email && p.to.includes(r.email)
              return (
                <div key={r.name}>
                  <span>{r.name}</span>
                  {r.role && <span className="text-muted-foreground">, {r.role}</span>}
                  <div className="text-xs text-muted-foreground">
                    {r.email || 'No address found'} · {confidence[r.confidence]}
                    {r.email &&
                      (added ? (
                        <span className="text-success"> · added</span>
                      ) : (
                        <>
                          {' · '}
                          <button onClick={() => onAddRecipient(r.email)} className="text-foreground hover:underline">
                            add
                          </button>
                        </>
                      ))}
                  </div>
                </div>
              )
            })}
          </div>
        </Section>
        {b.sections.map((section) => (
          <Section key={section.title} title={section.title}>
            <ul className="list-disc space-y-0.5 pl-4 marker:text-muted-foreground">
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Section>
        ))}
        {note}
        <Section title="Sources">
          <ol className="list-decimal space-y-0.5 pl-4 text-muted-foreground marker:text-muted-foreground/60">
            {b.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer" title={s.title} className="hover:text-foreground">
                  {hostname(s.url)}
                </a>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </ScrollArea>
  )
}

// One suggested change as a single line: removed words struck through, new ones highlighted.
function ChangeLine({ pr }: { pr: Proposal }) {
  const done = pr.state !== 'pending'
  return (
    <div className={cn('leading-relaxed', done && 'opacity-50')} title={pr.reason}>
      <span className="text-muted-foreground line-through">{plainText(pr.old)}</span> → <span className="text-mark-text">{plainText(pr.new)}</span>
    </div>
  )
}

function Proposals({ m, nextId, onProposal, onAll, onRevert }: { m: ChatMsg; nextId?: string; onProposal: Props['onProposal']; onAll: Props['onProposalsAll']; onRevert: Props['onRevertProposal'] }) {
  const list = m.proposals ?? []
  const pending = list.filter((x) => x.state === 'pending')
  const next = pending.find((x) => x.id === nextId) ?? pending[0]
  return (
    <div className="space-y-1.5">
      {list.map((pr) => (
        <div key={pr.id} className="flex items-baseline gap-2">
          <div className="min-w-0 flex-1">
            <ChangeLine pr={pr} />
          </div>
          {pr.state !== 'pending' && (
            <Quiet onClick={() => onRevert(m.id, pr.id)} className="shrink-0 text-xs">
              {pr.state === 'accepted' ? 'applied · undo' : 'rejected · undo'}
            </Quiet>
          )}
        </div>
      ))}
      {next && (
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 pt-0.5">
          <Quiet onClick={() => onProposal(m.id, next.id, true)} className="text-mark-text hover:text-mark-text">
            Accept {next.id === nextId && <Shortcut keys="⌘⇧↵" className="ml-0.5" />}
          </Quiet>
          <Quiet onClick={() => onProposal(m.id, next.id, false)}>
            Reject {next.id === nextId && <Shortcut keys="⌘⇧⌫" className="ml-0.5" />}
          </Quiet>
          {pending.length > 1 && (
            <>
              <Quiet onClick={() => onAll(m.id, true)}>Accept all</Quiet>
              <Quiet onClick={() => onAll(m.id, false)}>Reject all</Quiet>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ChatView({ prospect: p, onProposal, onProposalsAll, onRevertProposal, onSend, onStop, quote, onClearQuote }: Props) {
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const thread = activeChat(p)
  const messages = thread?.messages ?? []
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, messages.at(-1)?.text.length, thread?.id])
  // The suggestion ⌘⇧↵ / ⌘⇧⌫ act on: the first one still pending in this chat.
  const nextId = messages.flatMap((m) => m.proposals ?? []).find((x) => x.state === 'pending')?.id
  const ready = hasEmail(p)
  const replying = messages.some((m) => m.pending)

  const send = () => {
    if (!draft.trim() || !ready || replying) return
    onSend(draft.trim())
    setDraft('')
  }

  return (
    <>
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
        <div className="space-y-5 px-6 py-4 leading-relaxed">
          {!ready && <p className="text-muted-foreground">You can chat with the AI about {p.company} once it’s been researched.</p>}
          {ready && messages.length === 0 && (
            <div className="text-muted-foreground">
              {p.body.trim() ? 'Ask the AI to change the email, check something, or look something up.' : `Ask the AI about ${p.company} or what the research found.`}
              {p.body.trim() && (
                <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1">
                  {['Make it shorter', 'Stronger opening line', 'More casual'].map((s) => (
                    <Quiet key={s} onClick={() => onSend(s)} className="text-foreground/80">
                      {s}
                    </Quiet>
                  ))}
                </div>
              )}
            </div>
          )}
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="ml-auto w-fit max-w-[85%] text-right whitespace-pre-wrap">
                {m.quote && <div className="mb-0.5 line-clamp-2 text-xs text-muted-foreground">“{m.quote}”</div>}
                {m.text}
              </div>
            ) : (
              <div key={m.id} className="space-y-2 text-foreground/90">
                {m.pending && m.step && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 shrink-0 animate-spin" /> <span className="truncate">{m.step}</span>
                  </p>
                )}
                {m.pending && !m.text && !m.step ? (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Thinking…
                  </p>
                ) : m.error ? (
                  <p className="text-destructive">{m.text}</p>
                ) : (
                  m.text && (
                    <div className="chat-md">
                      <Markdown
                        components={{
                          a: ({ href, children }) => (
                            <a href={href} target="_blank" rel="noreferrer">
                              {children}
                            </a>
                          ),
                        }}
                      >
                        {m.text}
                      </Markdown>
                    </div>
                  )
                )}
                {m.stopped && <p className="text-xs text-muted-foreground">Stopped</p>}
                {m.comments && m.comments.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Pinned {m.comments.length === 1 ? 'a comment' : `${m.comments.length} comments`} to the email
                  </p>
                )}
                {m.proposals && m.proposals.length > 0 && (
                  <Proposals m={m} nextId={nextId} onProposal={onProposal} onAll={onProposalsAll} onRevert={onRevertProposal} />
                )}
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <div className="px-6 pt-2 pb-5">
        {quote && (
          <div className="mb-2 flex items-start gap-2 text-xs text-muted-foreground">
            <span className="line-clamp-2 min-w-0 flex-1">“{quote}”</span>
            <button onClick={onClearQuote} className="shrink-0 opacity-60 hover:opacity-100" title="Remove">
              <X className="size-3.5" />
            </button>
          </div>
        )}
        <textarea
          id="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          disabled={!ready}
          rows={2}
          placeholder={!ready ? 'Waiting for the research…' : quote ? 'Ask about the highlighted part…' : 'Ask or tell the AI what to change…'}
          className="field-sizing-content max-h-40 min-h-16 w-full resize-none rounded-xl bg-muted/60 px-3.5 py-3 outline-none placeholder:text-muted-foreground/70 disabled:opacity-50"
        />
        <p className="mt-1.5 text-xs text-muted-foreground/70">
          {replying ? (
            <button onClick={onStop} className="hover:text-foreground">
              Stop <span className="text-muted-foreground/60">esc</span>
            </button>
          ) : (
            '↵ send · ⇧↵ new line · ⌘N new chat'
          )}
        </p>
      </div>
    </>
  )
}
