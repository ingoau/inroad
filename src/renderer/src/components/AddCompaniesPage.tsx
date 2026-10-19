import { Button } from '@/components/ui/button'
import { Loader2, X } from 'lucide-react'
import { useState } from 'react'
import type { ParsedOrganisation } from '../../../shared/api'
import type { Campaign } from '../data'
import { Shortcut } from './hint'
import { TopBar } from './TopBar'

// A plain list of names, one per line, doesn't need the AI to read it.
const isPlainList = (lines: string[]) => lines.every((l) => l.length <= 60 && !/[,;:—–]|\s-\s|\.\s/.test(l) && l.split(/\s+/).length <= 5)

const asList = (lines: string[]): ParsedOrganisation[] =>
  lines.map((l) => {
    // "canva.com" on its own: the website, named after its first part.
    if (!/^[\w-]+(\.[\w-]+)+$/.test(l)) return { name: l, website: '', note: '' }
    const label = l.replace(/^www\./, '').split('.')[0]
    return { name: label[0].toUpperCase() + label.slice(1), website: l, note: '' }
  })

// Add organisations in your own words ("PCBWay, mention Campfire…"): the AI
// splits it into organisations with their own notes, which you check first.
// A page in the main area rather than a dialog, so there's room to write.
export function AddCompaniesPage({
  campaign,
  voiceName,
  text,
  onText,
  onAdd,
  onCancel,
  onResearchOnly,
}: {
  campaign: Campaign
  voiceName: string
  // What's been typed, kept by the app so leaving the page doesn't lose it.
  text: string
  onText: (text: string) => void
  onAdd: (orgs: ParsedOrganisation[]) => void
  onCancel: () => void
  onResearchOnly: (researchOnly: boolean) => void
}) {
  const [orgs, setOrgs] = useState<ParsedOrganisation[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const next = async () => {
    if (!lines.length || busy) return
    setError('')
    if (isPlainList(lines) || !window.api) return setOrgs(asList(lines))
    setBusy(true)
    const res = await window.api.claude.parseOrganisations(text)
    setBusy(false)
    if (!res.ok) return setError(res.error)
    setOrgs(res.value)
  }

  const valid = (orgs ?? []).filter((o) => o.name.trim())
  const submit = () => {
    if (!valid.length) return
    onAdd(valid.map((o) => ({ name: o.name.trim(), website: o.website.trim(), note: o.note.trim() })))
    onText('')
    setOrgs(null)
  }
  const edit = (i: number, patch: Partial<ParsedOrganisation>) => setOrgs((os) => os && os.map((o, j) => (j === i ? { ...o, ...patch } : o)))
  const field = 'bg-transparent outline-none placeholder:text-muted-foreground/50'

  return (
    <div className="@container flex h-full min-w-0 flex-col bg-background">
      <TopBar>
        <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
          ← Back <Shortcut keys="esc" />
        </button>
      </TopBar>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className="mx-auto flex max-w-[600px] flex-col gap-7 px-6 pt-12 pb-20"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              if (orgs) submit()
              else void next()
            }
          }}
        >
          <div>
            <h1 className="mb-2 font-heading text-2xl font-medium">Add to {campaign.name || 'this campaign'}</h1>
            <p className="text-muted-foreground">
              {orgs
                ? 'Check the list. Notes are followed for that organisation only, on top of the campaign’s notes and email format.'
                : 'Write it however you like: a list of names, or notes about what to say to each one.'}
            </p>
          </div>

          {!orgs ? (
            <>
              <textarea
                autoFocus
                aria-label="Organisations to add"
                value={text}
                onChange={(e) => onText(e.target.value)}
                rows={6}
                className={`field-sizing-content min-h-40 w-full resize-none text-base leading-relaxed ${field}`}
                placeholder={'Canva and Atlassian, both formal.\nPCBWay: they sponsored Campfire, so mention that and ask for about 40 badges.\nAlso JLCPCB (jlcpcb.com).'}
              />
              {error && (
                <p className="text-sm text-destructive">
                  {error}{' '}
                  <button className="underline" onClick={() => setOrgs(asList(lines))}>
                    Use one per line instead
                  </button>
                </p>
              )}
            </>
          ) : (
            <section aria-label="Found">
              <h2 className="mb-1 text-xs text-muted-foreground">
                {orgs.length ? `${valid.length} organisation${valid.length === 1 ? '' : 's'}` : 'No organisations found in that. Go back and try again.'}
              </h2>
              {orgs.map((o, i) => (
                <div key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 border-b border-border/50 py-2.5">
                  <input
                    autoFocus={i === 0}
                    value={o.name}
                    onChange={(e) => edit(i, { name: e.target.value })}
                    aria-label="Organisation"
                    className={`field-sizing-content min-w-24 font-medium ${field}`}
                  />
                  {o.website && <span className="text-sm text-muted-foreground">{o.website}</span>}
                  <input
                    value={o.note}
                    onChange={(e) => edit(i, { note: e.target.value })}
                    aria-label={`Note for ${o.name}`}
                    placeholder="Anything to say or look for (optional)"
                    className={`min-w-48 flex-1 text-sm text-muted-foreground ${field}`}
                  />
                  <button title={`Remove ${o.name}`} onClick={() => setOrgs(orgs.filter((_, j) => j !== i))} className="text-muted-foreground/60 hover:text-foreground">
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </section>
          )}

          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 text-sm">
            {orgs ? (
              <>
                <Button disabled={!valid.length} onClick={submit} className="h-9 rounded-full px-4">
                  Research {valid.length || ''} <span className="opacity-60">⌘↵</span>
                </Button>
                <button onClick={() => setOrgs(null)} className="text-muted-foreground hover:text-foreground">
                  Edit the text
                </button>
              </>
            ) : (
              <Button disabled={!lines.length || busy} onClick={next} className="h-9 rounded-full px-4">
                {busy && <Loader2 className="animate-spin" />}
                {busy ? 'Reading…' : 'Next'} {!busy && <span className="opacity-60">⌘↵</span>}
              </Button>
            )}
            <span className="text-muted-foreground">
              {campaign.researchOnly
                ? 'Research only: you write each email, or press ⌘R to have the AI draft it.'
                : `Research and draft, in the “${voiceName}” voice.`}{' '}
              <button onClick={() => onResearchOnly(!campaign.researchOnly)} className="text-foreground hover:underline">
                Change
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
