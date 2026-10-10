import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ArrowLeft, ArrowRight, CircleAlert, Globe, Loader2, Sparkles, WandSparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ParsedOrganisation } from '../../../shared/api'
import type { Campaign } from '../data'
import { useAgentName } from '../agent'
import { ButtonKeys } from './hint'

// A plain list of names, one per line, doesn't need Claude to read it.
const isPlainList = (lines: string[]) => lines.every((l) => l.length <= 60 && !/[,;:—–]|\s-\s|\.\s/.test(l) && l.split(/\s+/).length <= 5)

const asList = (lines: string[]): ParsedOrganisation[] =>
  lines.map((l) => {
    // "canva.com" on its own: the website, named after its first part.
    if (!/^[\w-]+(\.[\w-]+)+$/.test(l)) return { name: l, website: '', note: '' }
    const label = l.replace(/^www\./, '').split('.')[0]
    return { name: label[0].toUpperCase() + label.slice(1), website: l, note: '' }
  })

// Add organisations in your own words ("PCBWay, mention Campfire…"): Claude
// splits it into organisations with their own notes, which you check first.
export function AddCompaniesDialog({
  open,
  onOpenChange,
  campaign,
  voiceName,
  eventInfo,
  existing,
  onAdd,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  campaign: Campaign
  voiceName: string
  // The folder's shared context; what "Suggest leads" reasons from.
  eventInfo: string
  // Organisations already in the campaign, so suggestions don't repeat them.
  existing?: string[]
  onAdd: (orgs: ParsedOrganisation[]) => void
}) {
  const agent = useAgentName()
  const [text, setText] = useState('')
  const [orgs, setOrgs] = useState<ParsedOrganisation[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Whether we're asking the agent for suggestions, and its last progress lines.
  const [suggesting, setSuggesting] = useState(false)
  const [steps, setSteps] = useState<string[]>([])
  const [suggestError, setSuggestError] = useState('')
  const job = useRef('')
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  // Start on the writing step each time it opens; keep what was typed.
  useEffect(() => {
    if (!open) return
    setOrgs(null)
    setError('')
    setSteps([])
    setSuggestError('')
  }, [open])

  // Progress from a "Suggest leads" run (search and page reads).
  useEffect(() => window.api?.claude.onProgress((p) => {
    if (p.jobId === job.current && p.kind === 'step') setSteps((s) => [...s, p.text])
  }), [])

  const canSuggest = !!window.api && !suggesting && !!(eventInfo.trim() || campaign.notes.trim())

  const suggest = async () => {
    if (!canSuggest) return
    job.current = crypto.randomUUID()
    setSuggesting(true)
    setSteps([])
    setSuggestError('')
    const res = await window.api!.claude.suggestLeads({
      jobId: job.current,
      eventInfo: eventInfo.trim(),
      campaignNotes: campaign.notes.trim(),
      emailFormat: campaign.format,
      existing,
      count: 8,
    })
    setSuggesting(false)
    if (!res.ok) return setSuggestError(res.error)
    setOrgs(res.value)
  }

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
    setText('')
    setOrgs(null)
  }
  const edit = (i: number, patch: Partial<ParsedOrganisation>) => setOrgs((os) => os && os.map((o, j) => (j === i ? { ...o, ...patch } : o)))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add to {campaign.name}</DialogTitle>
          <DialogDescription>
            {orgs
              ? 'Check the list. Notes are followed for that organisation only, on top of the campaign’s notes and email format.'
              : `Write it however you like — a list of names, or notes about what to say to each one — or have ${agent} suggest leads from your event info.`}
          </DialogDescription>
        </DialogHeader>

        {!orgs ? (
          <>
            <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/30 p-3">
              <div className="text-sm">
                <div className="font-medium">Suggest leads</div>
                <p className="mt-0.5 text-muted-foreground">
                  {eventInfo.trim() || campaign.notes.trim()
                    ? `${agent} proposes organisations to reach, based on the folder’s event info and this campaign. You review them before adding.`
                    : 'Add the event info (in the folder’s settings) or this campaign’s notes first, so there’s something to work from.'}
                </p>
              </div>
              <Button variant="outline" className="shrink-0" disabled={!canSuggest} onClick={suggest}>
                {suggesting ? <Loader2 className="animate-spin" /> : <WandSparkles />} Suggest
              </Button>
            </div>
            {suggesting && (
              <ol className="space-y-1 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
                {(steps.length ? steps : ['Thinking…']).slice(-5).map((s, i, all) => (
                  <li key={i} className={i === all.length - 1 ? 'flex items-center gap-2 text-foreground' : 'pl-6'}>
                    {i === all.length - 1 && <Loader2 className="size-4 shrink-0 animate-spin" />}
                    {s}
                  </li>
                ))}
              </ol>
            )}
            {suggestError && (
              <p className="flex items-start gap-2 text-sm text-destructive">
                <CircleAlert className="mt-0.5 size-4 shrink-0" /> {suggestError}
              </p>
            )}
            <Textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') next()
              }}
              rows={7}
              placeholder={
                'Canva and Atlassian, both formal.\nPCBWay: they sponsored Campfire, so mention that and ask for about 40 badges.\nAlso JLCPCB (jlcpcb.com).'
              }
            />
            {error && (
              <p className="flex items-start gap-2 text-sm text-destructive">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  {error}{' '}
                  <button className="underline" onClick={() => setOrgs(asList(lines))}>
                    Use one per line instead
                  </button>
                </span>
              </p>
            )}
          </>
        ) : (
          <div
            className="max-h-[50vh] divide-y overflow-y-auto rounded-lg border"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit()
            }}
          >
            {orgs.length === 0 && <p className="p-3 text-sm text-muted-foreground">{agent} didn’t find any organisations. Go back and try again.</p>}
            {orgs.map((o, i) => (
              <div key={i} className="grid gap-1.5 p-2.5">
                <div className="flex items-center gap-2">
                  <Input value={o.name} onChange={(e) => edit(i, { name: e.target.value })} aria-label="Organisation" className="h-8 flex-1 font-medium" />
                  {o.website && (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <Globe className="size-3" /> {o.website}
                    </span>
                  )}
                  <Button variant="ghost" size="icon-sm" title={`Remove ${o.name}`} onClick={() => setOrgs(orgs.filter((_, j) => j !== i))}>
                    <X />
                  </Button>
                </div>
                <Input
                  value={o.note}
                  onChange={(e) => edit(i, { note: e.target.value })}
                  aria-label={`Note for ${o.name}`}
                  placeholder="Anything to say or look for with this one (optional)"
                  className="h-8 text-muted-foreground"
                />
              </div>
            ))}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Each one is researched and drafted from the folder’s context and this campaign’s notes, written in the “{voiceName}” voice.
        </p>
        <DialogFooter>
          {orgs ? (
            <>
              <Button variant="ghost" onClick={() => setOrgs(null)}>
                <ArrowLeft /> Back
              </Button>
              <Button disabled={!valid.length} onClick={submit}>
                <Sparkles /> Research {valid.length || ''}
                <ButtonKeys keys="⌘ ↵" primary />
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={!lines.length || busy} onClick={next}>
                {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />} {busy ? 'Reading…' : 'Next'}
                {!busy && <ButtonKeys keys="⌘ ↵" primary />}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
