import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Textarea } from '@/components/ui/textarea'
import { ArrowLeft, ArrowRight, CircleAlert, Globe, Loader2, Sparkles, X } from 'lucide-react'
import { useState } from 'react'
import type { ParsedOrganisation } from '../../../shared/api'
import type { Campaign } from '../data'
import { ButtonKeys, Hint, Keys } from './hint'

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

  return (
    <div className="@container flex h-full min-w-0 flex-col bg-background">
      <header className="drag flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Hint label="Toggle sidebar" keys="⌘ \">
          <SidebarTrigger />
        </Hint>
        <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
        <h1 className="min-w-0 flex-1 truncate font-heading text-base font-semibold">Add to {campaign.name || 'this campaign'}</h1>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel <Keys keys="esc" className="@max-md:hidden" />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className="mx-auto max-w-[720px] space-y-4 px-8 py-8 @max-xl:px-4"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              if (orgs) submit()
              else void next()
            }
          }}
        >
          <p className="text-muted-foreground">
            {orgs
              ? 'Check the list. Notes are followed for that organisation only, on top of the campaign’s notes and email format.'
              : 'Write it however you like: a list of names, or notes about what to say to each one.'}
          </p>

          {!orgs ? (
            <>
              <Textarea
                autoFocus
                value={text}
                onChange={(e) => onText(e.target.value)}
                rows={12}
                className="min-h-64 leading-relaxed"
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
            <div className="divide-y rounded-lg border">
              {orgs.length === 0 && <p className="p-3 text-sm text-muted-foreground">No organisations found in that. Go back and try again.</p>}
              {orgs.map((o, i) => (
                <div key={i} className="grid gap-1.5 p-2.5">
                  <div className="flex items-center gap-2">
                    <Input
                      autoFocus={i === 0}
                      value={o.name}
                      onChange={(e) => edit(i, { name: e.target.value })}
                      aria-label="Organisation"
                      className="h-8 flex-1 font-medium"
                    />
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

          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2.5 text-sm">
            <span className="min-w-0 flex-1 text-muted-foreground">
              {campaign.researchOnly
                ? 'Each one is researched from the folder’s context and this campaign’s notes. You write emails one at a time when you want them.'
                : `Each one is researched and drafted from the folder’s context and this campaign’s notes, written in the “${voiceName}” voice.`}
            </span>
            <Select value={campaign.researchOnly ? 'research' : 'draft'} onValueChange={(v) => onResearchOnly(v === 'research')}>
              <SelectTrigger size="sm" className="w-48" aria-label="Drafting">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="draft">Research and draft</SelectItem>
                <SelectItem value="research">Research only</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex justify-end gap-2">
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
              <Button disabled={!lines.length || busy} onClick={next}>
                {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />} {busy ? 'Reading…' : 'Next'}
                {!busy && <ButtonKeys keys="⌘ ↵" primary />}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
