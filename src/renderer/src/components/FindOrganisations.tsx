import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Check, Loader2, X } from 'lucide-react'
import { useState } from 'react'
import { orgKey } from '../../../shared/org'
import type { Candidate, Discovery } from '../data'

// Sources come from the model, so don't trust them to be valid URLs.
const hostname = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export interface FindProps {
  discovery?: Discovery
  // Organisations already in the campaign, by orgKey, so their suggestion shows as added.
  addedIds: Record<string, string>
  // The first query, kept by the app so leaving the page doesn't lose it.
  text: string
  onText: (text: string) => void
  onDiscover: (query: string) => void
  onStop: () => void
  onAdd: (cands: Candidate[]) => void
  onDismiss: (name: string, dismissed: boolean) => void
  onOpen: (prospectId: string) => void
  onNewSearch: () => void
}

// "Find with AI": describe who you're after, and the agent suggests
// organisations one at a time. Each one is a click to add, which starts its
// research. The search itself runs in the app, so it carries on if you leave.
export function FindOrganisations(props: FindProps) {
  const { discovery, addedIds } = props
  const [more, setMore] = useState('')
  const [showDismissed, setShowDismissed] = useState(false)
  const rounds = discovery?.rounds ?? []
  const searching = rounds.some((r) => r.status === 'searching')
  const dismissed = new Set((discovery?.dismissed ?? []).map(orgKey))
  const isDismissed = (c: Candidate) => dismissed.has(orgKey(c.name))
  const addedId = (c: Candidate) => addedIds[orgKey(c.name)]
  const all = rounds.flatMap((r) => r.candidates)
  const pending = all.filter((c) => !isDismissed(c) && !addedId(c))
  const field = 'bg-transparent outline-none placeholder:text-muted-foreground/50'

  // Every dismissed name, including ones from searches since cleared, so any can be restored.
  const dismissedNames = discovery?.dismissed ?? []
  const dismissedToggle = dismissedNames.length > 0 && (
    <button onClick={() => setShowDismissed((v) => !v)} className="ml-auto hover:text-foreground">
      {showDismissed ? 'Hide dismissed' : `${dismissedNames.length} dismissed`}
    </button>
  )
  const dismissedList = showDismissed && dismissedNames.length > 0 && (
    <section aria-label="Dismissed">
      <h2 className="mb-1 text-xs text-muted-foreground">Dismissed. Inroad won’t suggest these again.</h2>
      {dismissedNames.map((name) => {
        const website = all.find((c) => orgKey(c.name) === orgKey(name))?.website
        return (
          <div key={name} className="flex items-baseline gap-3 border-b border-border/50 py-2 text-sm text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              {name}
              {website && <span className="ml-2 text-xs">{hostname(website)}</span>}
            </span>
            <button onClick={() => props.onDismiss(name, false)} className="text-foreground hover:underline">
              Restore
            </button>
          </div>
        )
      })}
    </section>
  )

  if (!rounds.length) {
    const find = () => props.text.trim() && props.onDiscover(props.text)
    return (
      <>
        <textarea
          autoFocus
          aria-label="Who to look for"
          value={props.text}
          onChange={(e) => props.onText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              find()
            }
          }}
          rows={4}
          className={`field-sizing-content min-h-28 w-full resize-none text-base leading-relaxed ${field}`}
          placeholder={'Who are you after? For example: companies likely to sponsor a student hackathon in Canberra, especially hardware and dev tools.'}
        />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
          <Button disabled={!props.text.trim()} onClick={find} className="h-9 rounded-full px-4">
            Find <span className="opacity-60">⌘↵</span>
          </Button>
          <span className="text-muted-foreground">About 10 at a time, from the web and your connected apps.</span>
          {dismissedToggle}
        </div>
        {dismissedList}
      </>
    )
  }

  const findMore = () => {
    if (searching) return
    props.onDiscover(more.trim() || '10 more')
    setMore('')
  }

  return (
    <>
      {rounds.map((r, i) => {
        const shown = r.candidates.filter((c) => !isDismissed(c))
        return (
          <section key={r.id} aria-label={r.query}>
            <h2 className="mb-1 text-xs text-muted-foreground">
              <span className="text-foreground">“{r.query}”</span>
              {r.status === 'stopped' && ' · stopped'}
            </h2>
            {shown.map((c) => (
              <CandidateRow
                key={c.name}
                c={c}
                addedId={addedId(c)}
                onAdd={() => props.onAdd([c])}
                onDismiss={() => props.onDismiss(c.name, true)}
                onOpen={props.onOpen}
              />
            ))}
            {/* Below the results, so they don't jump when the search ends. */}
            {r.status === 'searching' && (
              <div className="mt-3 flex flex-col gap-0.5 border-l border-border pl-3 text-xs text-muted-foreground" aria-live="polite">
                {(r.steps.length ? r.steps.slice(-3) : ['Starting']).map((step, j, a) => (
                  <div
                    key={r.steps.length - a.length + j}
                    className={cn('animate-in fade-in', j === a.length - 1 && 'flex items-center gap-1.5 text-foreground')}
                  >
                    {j === a.length - 1 && <Loader2 className="size-3 animate-spin" />}
                    {step}
                  </div>
                ))}
                <div className="pt-1">
                  <button onClick={props.onStop} className="text-foreground hover:underline">
                    Stop
                  </button>{' '}
                  · It keeps going if you leave this page.
                </div>
              </div>
            )}
            {r.status === 'failed' && (
              <p className="py-2 text-sm text-destructive">
                {r.error}{' '}
                {i === rounds.length - 1 && !searching && (
                  <button className="underline" onClick={() => props.onDiscover(r.query)}>
                    Try again
                  </button>
                )}
              </p>
            )}
            {r.status !== 'searching' && r.status !== 'failed' && !shown.length && <p className="py-2 text-sm text-muted-foreground">Nothing new found.</p>}
          </section>
        )
      })}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
        {pending.length > 1 && (
          <Button variant="outline" onClick={() => props.onAdd(pending)} className="h-8 rounded-full px-3.5">
            Add all {pending.length}
          </Button>
        )}
        {!searching && (
          <button onClick={props.onNewSearch} className="hover:text-foreground">
            New search
          </button>
        )}
        {dismissedToggle}
      </div>

      {dismissedList}

      <div className="sticky bottom-4 flex items-center gap-2 rounded-full border bg-background py-1 pr-1 pl-4 shadow-md">
        <input
          aria-label="Find more"
          value={more}
          onChange={(e) => setMore(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault()
              findMore()
            }
          }}
          placeholder={searching ? 'Searching…' : 'Find more: “10 more”, “Australian only”, “more like Altium”'}
          className={`min-w-0 flex-1 text-sm ${field}`}
        />
        <Button disabled={searching} onClick={findMore} className="h-8 rounded-full px-3.5">
          Find more
        </Button>
      </div>
    </>
  )
}

function CandidateRow({
  c,
  addedId,
  onAdd,
  onDismiss,
  onOpen,
}: {
  c: Candidate
  addedId?: string
  onAdd: () => void
  onDismiss: () => void
  onOpen: (id: string) => void
}) {
  const source = c.sources[0]
  return (
    <div className="flex animate-in gap-4 border-b border-border/50 py-3 fade-in slide-in-from-bottom-1">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn('font-medium', addedId && 'text-muted-foreground')}>{c.name}</span>
          {c.website && <span className="text-sm text-muted-foreground">{hostname(c.website)}</span>}
          <span className={cn('rounded-full px-1.5 text-[11px]', c.fit === 'strong' ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground')}>
            {c.fit === 'strong' ? 'Strong fit' : 'Possible'}
          </span>
        </div>
        <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{c.why}</p>
        {source &&
          (source.url ? (
            <a
              href={source.url}
              target="_blank"
              rel="noreferrer"
              title={source.title}
              className="text-xs text-muted-foreground/80 underline decoration-border underline-offset-2 hover:text-foreground"
            >
              {source.title || hostname(source.url)}
            </a>
          ) : (
            <span className="text-xs text-muted-foreground/80">{source.title}</span>
          ))}
      </div>
      <div className="flex shrink-0 items-start gap-1">
        {addedId ? (
          <button
            onClick={() => onOpen(addedId)}
            title="Open the email"
            className="flex h-7 items-center gap-1 rounded-full bg-success/10 px-3 text-xs font-medium text-success hover:bg-success/15"
          >
            <Check className="size-3.5" /> Added
          </button>
        ) : (
          <>
            <button onClick={onAdd} className="h-7 rounded-full border px-3 text-xs font-medium transition-colors hover:bg-muted">
              + Add
            </button>
            <button
              onClick={onDismiss}
              title={`Dismiss ${c.name}`}
              aria-label={`Dismiss ${c.name}`}
              className="grid size-7 place-items-center rounded-full text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
