import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import Markdown from 'react-markdown'
import {
  ArrowUp,
  Check,
  ChevronsUpDown,
  CircleAlert,
  ExternalLink,
  FileText,
  Link2,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  MessageSquareText,
  Sparkles,
  Trash2,
  Undo2,
  UserPlus,
  X,
} from 'lucide-react'
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
import type { ChatThread, Prospect, Recipient } from '../data'
import { DiffText } from './DiffText'
import { ButtonKeys, Hint } from './hint'

export type Tab = 'brief' | 'chat'

interface Props {
  prospect: Prospect
  tab: Tab
  onTab: (t: Tab) => void
  onClose: () => void
  onAddRecipient: (email: string) => void
  onNote: (note: string) => void
  onProposal: (msgId: string, proposalId: string, accept: boolean) => void
  onRevertProposal: (msgId: string, proposalId: string) => void
  onSend: (text: string) => void
  onNewChat: () => void
  onSelectChat: (id: string) => void
  onDeleteChat: (id: string) => void
}

// The thread the chat panel shows: the selected one if it still exists, else the newest.
export function activeChat(p: Prospect): ChatThread | undefined {
  const alive = p.chats.filter((c) => !c.deletedAt)
  return alive.find((c) => c.id === p.activeChatId) ?? alive.at(-1)
}

export function RightPanel(props: Props) {
  const { prospect: p, tab, onTab, onClose, onAddRecipient } = props
  const pending = (activeChat(p)?.messages ?? []).flatMap((m) => m.proposals ?? []).filter((x) => x.state === 'pending').length

  return (
    <div className="flex h-full min-w-0 flex-col bg-sidebar">
      <div className="drag flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Tabs value={tab} onValueChange={(v) => onTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="brief">
              <FileText /> Brief
            </TabsTrigger>
            <TabsTrigger value="chat">
              <MessageSquare /> Chat
              {pending > 0 && <Badge className="h-4 min-w-4 bg-mark px-1 text-[10px] text-black">{pending}</Badge>}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex-1" />
        <Hint label="Close panel" keys="⌘ ⇧ \">
          <Button variant="ghost" size="icon-sm" onClick={onClose}>
            <X />
          </Button>
        </Hint>
      </div>
      {tab === 'brief' ? <BriefView prospect={p} onAddRecipient={onAddRecipient} onNote={props.onNote} /> : <ChatView {...props} />}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

// Your instructions for this organisation, editable any time. Claude follows
// them on the next regenerate or chat message.
function NoteField({ prospect: p, onNote }: { prospect: Prospect; onNote: (note: string) => void }) {
  return (
    <Section title="Your note">
      <Textarea
        value={p.note ?? ''}
        onChange={(e) => onNote(e.target.value)}
        placeholder={`Anything the AI should say or look for with ${p.company}`}
        className="min-h-16 resize-none bg-background text-sm"
      />
      {p.note?.trim() && p.originalBody && <p className="mt-1.5 text-xs text-muted-foreground">Changed it? Regenerate (⌘R) or ask in chat to apply it.</p>}
    </Section>
  )
}

function BriefView({ prospect: p, onAddRecipient, onNote }: { prospect: Prospect; onAddRecipient: (e: string) => void; onNote: (note: string) => void }) {
  const b = p.brief
  // Sources come from the model, so don't trust them to be valid URLs.
  const hostname = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }
  if (!b)
    return (
      <div className="space-y-5 p-4 text-sm">
        <NoteField prospect={p} onNote={onNote} />
        <p className="text-muted-foreground">The brief appears here once {p.company} has been researched.</p>
      </div>
    )

  return (
    <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
      <div className="space-y-5 p-4 text-sm">
        <NoteField prospect={p} onNote={onNote} />
        <Section title="Summary">
          <p className="leading-relaxed">{b.summary}</p>
        </Section>

        <Section title="Possible recipients">
          <div className="space-y-2">
            {b.recipients.map((r) => (
              <RecipientCard key={r.name} r={r} added={p.to.includes(r.email)} onAdd={() => onAddRecipient(r.email)} />
            ))}
          </div>
        </Section>

        {b.sections.map((section) => (
          <Section key={section.title} title={section.title}>
            <ul className="list-disc space-y-1 pl-4 marker:text-muted-foreground">
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </Section>
        ))}

        <Section title="Sources">
          <ol className="space-y-1.5 text-xs">
            {b.sources.map((s, i) => (
              <li key={s.url} className="flex gap-2">
                <span className="text-muted-foreground">{i + 1}.</span>
                <a href={s.url} target="_blank" rel="noreferrer" className="flex min-w-0 flex-1 items-center gap-1.5 hover:underline">
                  <span className="truncate">{s.title}</span>
                  <span className="shrink-0 text-muted-foreground">{hostname(s.url)}</span>
                  <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                </a>
              </li>
            ))}
          </ol>
        </Section>
      </div>
    </ScrollArea>
  )
}

function RecipientCard({ r, added, onAdd }: { r: Recipient; added: boolean; onAdd: () => void }) {
  const confidence = { high: 'High confidence', medium: 'Medium confidence', low: 'Guessed' }[r.confidence]
  return (
    <Card size="sm" className="gap-1 py-2.5">
      <CardContent className="flex items-start gap-3 text-sm">
        <div className="min-w-0 flex-1">
          <div className="font-medium">{r.name}</div>
          {r.role && <div className="line-clamp-2 text-xs text-muted-foreground">{r.role}</div>}
          {r.email && <div className="mt-0.5 truncate text-xs">{r.email}</div>}
          <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
            <Badge variant={r.confidence === 'low' ? 'destructive' : r.confidence === 'high' ? 'secondary' : 'outline'} className="font-normal">
              {confidence}
            </Badge>
            <Link2 className="size-3 shrink-0" />
            <span className="truncate" title={r.source}>
              {r.source}
            </span>
          </div>
        </div>
        {r.email ? (
          <Button variant={added ? 'ghost' : 'outline'} size="sm" onClick={onAdd} disabled={added} className={cn(added && 'text-success')}>
            {added ? <Check /> : <UserPlus />}
            {added ? 'Added' : 'Add'}
          </Button>
        ) : (
          <span className="pt-1 text-xs text-muted-foreground">No email</span>
        )}
      </CardContent>
    </Card>
  )
}

function ChatView({ prospect: p, onProposal, onRevertProposal: onRevert, onSend, onNewChat, onSelectChat, onDeleteChat }: Props) {
  const [draft, setDraft] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const thread = activeChat(p)
  const threads = p.chats.filter((c) => !c.deletedAt)
  const messages = thread?.messages ?? []
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, messages.at(-1)?.text.length, thread?.id])
  // The suggestion ⌘⇧↵ / ⌘⇧⌫ act on: the first one still pending in this chat.
  const nextId = messages.flatMap((m) => m.proposals ?? []).find((x) => x.state === 'pending')?.id
  const ready = !!p.originalBody
  const replying = messages.some((m) => m.pending)

  const send = () => {
    if (!draft.trim() || !ready || replying) return
    onSend(draft.trim())
    setDraft('')
  }

  return (
    <>
      {ready && (
        <div className="flex shrink-0 items-center gap-1 border-b px-3 py-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start" disabled={!threads.length}>
                <MessageSquare />
                <span className="truncate">{thread?.title ?? 'No chats yet'}</span>
                {threads.length > 1 && <span className="text-muted-foreground">{threads.length}</span>}
                <ChevronsUpDown className="ml-auto text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuRadioGroup value={thread?.id} onValueChange={onSelectChat}>
                {[...threads].reverse().map((c) => (
                  <DropdownMenuRadioItem key={c.id} value={c.id}>
                    <span className="truncate">{c.title}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onNewChat}>
                <MessageSquarePlus /> New chat
              </DropdownMenuItem>
              {thread && (
                <DropdownMenuItem variant="destructive" onSelect={() => onDeleteChat(thread.id)}>
                  <Trash2 /> Delete this chat
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          <Hint label="New chat">
            <Button variant="ghost" size="icon-sm" onClick={onNewChat}>
              <MessageSquarePlus />
            </Button>
          </Hint>
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
        <div className="space-y-4 p-4 text-sm">
          {!ready && messages.length === 0 && <p className="text-muted-foreground">You can chat with the AI about {p.company} once its draft is ready.</p>}
          {ready && messages.length === 0 && (
            <div className="text-muted-foreground">
              <Sparkles className="mb-2 size-4" />
              Ask the AI to change the email. Try:
              <div className="mt-2 flex flex-wrap gap-1.5">
                {['Make it shorter', 'Stronger opening line', 'More casual'].map((s) => (
                  <Button key={s} variant="outline" size="xs" onClick={() => onSend(s)}>
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="ml-auto w-fit max-w-[85%] rounded-lg bg-primary px-3 py-2 text-primary-foreground">
                {m.text}
              </div>
            ) : (
              <div key={m.id} className="space-y-2">
                {m.pending && !m.text ? (
                  <p className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Thinking…
                  </p>
                ) : m.error ? (
                  <p className="flex items-start gap-2 text-destructive">
                    <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {m.text}
                  </p>
                ) : (
                  <div className="chat-md leading-relaxed">
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
                )}
                {m.comments && m.comments.length > 0 && (
                  <div className="grid gap-1 rounded-lg border px-3 py-2">
                    <div className="text-xs text-muted-foreground">Pinned to the email</div>
                    {m.comments.map((c, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs/relaxed">
                        {c.kind === 'verify' ? (
                          <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-mark" aria-label="Check this" />
                        ) : (
                          <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-label="Note" />
                        )}
                        <span>
                          <span className="text-muted-foreground">“{c.quote}”</span> {c.comment}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {m.proposals?.map((pr, i) => {
                  const isNext = pr.id === nextId
                  return (
                    <Card key={pr.id} size="sm" className={cn('gap-0 py-0', isNext && 'ring-2 ring-mark', pr.state !== 'pending' && 'opacity-70')}>
                      <CardHeader className="flex flex-row items-center gap-2 border-b py-2!">
                        <Sparkles className="size-3.5 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{pr.reason}</span>
                        <span className="text-xs text-muted-foreground">
                          {i + 1}/{m.proposals!.length}
                        </span>
                      </CardHeader>
                      <CardContent className="py-2.5 text-sm leading-relaxed">
                        <DiffText a={pr.old} b={pr.new} />
                      </CardContent>
                      <CardFooter className="justify-end gap-1 border-t py-1.5!">
                        {pr.state === 'pending' ? (
                          <>
                            <Button variant="ghost" size="sm" onClick={() => onProposal(m.id, pr.id, false)}>
                              <X /> Reject {isNext && <ButtonKeys keys="⌘ ⇧ ⌫" />}
                            </Button>
                            <Button size="sm" onClick={() => onProposal(m.id, pr.id, true)}>
                              <Check /> Accept {isNext && <ButtonKeys keys="⌘ ⇧ ↵" primary />}
                            </Button>
                          </>
                        ) : (
                          <>
                            <span className={cn('mr-auto flex items-center gap-1 text-xs', pr.state === 'accepted' ? 'text-success' : 'text-muted-foreground')}>
                              {pr.state === 'accepted' ? <Check className="size-3.5" /> : <X className="size-3.5" />}
                              {pr.state === 'accepted' ? 'Applied' : 'Rejected'}
                            </span>
                            <Button variant="ghost" size="sm" onClick={() => onRevert(m.id, pr.id)}>
                              <Undo2 /> Undo
                            </Button>
                          </>
                        )}
                      </CardFooter>
                    </Card>
                  )
                })}
              </div>
            ),
          )}
          <div ref={endRef} />
        </div>
      </ScrollArea>

      <div className="border-t p-3">
        <div className="relative">
          <Textarea
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
            placeholder={ready ? `Tell the AI what to change in the ${p.company} email…` : 'Waiting for the draft…'}
            className="max-h-40 min-h-16 resize-none bg-background pr-10"
          />
          <Button size="icon-xs" onClick={send} disabled={!draft.trim() || !ready || replying} className="absolute right-2 bottom-2" title="Send (↵)">
            <ArrowUp />
          </Button>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">{replying ? 'The AI is replying…' : 'The AI sees the email, the brief and your voice.'}</p>
      </div>
    </>
  )
}
