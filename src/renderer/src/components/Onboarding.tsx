import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { ArrowLeft, ArrowRight, Check, CircleAlert, Loader2, Plus, Sparkles, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { PublicSettings } from '../../../shared/api'
import icon from '../assets/icon.png'
import { useAiProvider } from '../agent'
import { ClaudeSetupDialog } from './ClaudeSetupDialog'
import { FolderFields, type FolderInfo } from './FolderFields'
import { MailboxForm } from './settings/GeneralPages'

export interface OnboardingResult {
  // The first folder, usually the event.
  folder: FolderInfo
  campaign: { name: string; notes: string }
  // Style notes, and the emails they came from (kept as examples).
  rules: string[]
  emails: string[]
}

const CAMPAIGN_IDEAS = ['Sponsors', 'Venues', 'Partners', 'Speakers', 'Judges']

// First-run setup: a welcome page and Claude connection, then the event, the
// first campaign, how the user writes, and their mailbox.
export function Onboarding({
  onFinish,
  onSkip,
  settings,
  onSettings,
}: {
  onFinish: (r: OnboardingResult) => void
  onSkip: () => void
  settings: PublicSettings | null
  onSettings: (s: PublicSettings) => void
}) {
  const mailConnected = !!settings?.mail && !!settings.hasMailPassword
  const provider = useAiProvider()
  // A welcome page comes first; "Get started" asks how to connect Claude, then the steps begin.
  const [welcome, setWelcome] = useState(true)
  const [connecting, setConnecting] = useState(false)
  const [step, setStep] = useState(0)
  const [folder, setFolder] = useState<FolderInfo>({ name: '', notes: '' })
  const [campaign, setCampaign] = useState({ name: 'Sponsors', notes: '' })
  const [emails, setEmails] = useState([''])
  const [rules, setRules] = useState<string[] | null>(null)
  const [newRule, setNewRule] = useState('')
  const [learning, setLearning] = useState(false)
  const [error, setError] = useState('')

  const pasted = emails.map((e) => e.trim()).filter(Boolean)
  const finish = () => onFinish({ folder, campaign, rules: rules ?? [], emails: pasted })

  const learn = async () => {
    if (!window.api || !pasted.length) return
    setLearning(true)
    setError('')
    const res = await window.api.claude.writingRules({ emails: pasted })
    setLearning(false)
    if (!res.ok) return setError(res.error)
    setRules(res.value.notes)
  }

  const steps: { title: string; description: string; body: ReactNode; canContinue: boolean; next?: ReactNode }[] = [
    {
      title: 'What’s your event?',
      description:
        `It becomes a folder for your campaigns, and the AI uses it in every email. Type the name and the AI can pull the details from ${provider === 'opencode' ? 'the web' : 'your connected apps and the web'}.`,
      body: <FolderFields folder={folder} onChange={setFolder} autoFocus />,
      canContinue: !!folder.name.trim(),
    },
    {
      title: 'Who are you reaching out to first?',
      description: 'Each campaign in the folder is one group of organisations with one ask, like Venues or Sponsors. You can add more later.',
      canContinue: !!campaign.name.trim(),
      body: (
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="campaign-name">Campaign</Label>
            <Input id="campaign-name" value={campaign.name} onChange={(e) => setCampaign({ ...campaign, name: e.target.value })} />
            <div className="flex flex-wrap gap-1.5">
              {CAMPAIGN_IDEAS.map((n) => (
                <Button key={n} size="xs" variant={campaign.name === n ? 'secondary' : 'outline'} onClick={() => setCampaign({ ...campaign, name: n })}>
                  {n}
                </Button>
              ))}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="campaign-notes">What are you asking them for?</Label>
            <Textarea
              id="campaign-notes"
              value={campaign.notes}
              onChange={(e) => setCampaign({ ...campaign, notes: e.target.value })}
              placeholder="e.g. Sponsorship: Gold $5k with a prize track, or API credits and a workshop. Look for dev tools with a free tier and grad hiring in Sydney. Mention the prospectus."
              className="min-h-40 leading-relaxed"
            />
            <p className="text-xs text-muted-foreground">
              Include tiers or prices, what they get back, and what the AI should look for when researching each one.
            </p>
          </div>
        </div>
      ),
    },
    {
      title: 'How do you write?',
      description: `Paste a few emails you’ve written, ideally similar outreach. The AI turns them into style rules and keeps them as examples.`,
      canContinue: true,
      body: (
        <div className="grid gap-3">
          {emails.map((e, i) => (
            <div key={i} className="relative">
              <Textarea
                autoFocus={i === 0}
                value={e}
                onChange={(ev) => setEmails(emails.map((x, j) => (j === i ? ev.target.value : x)))}
                placeholder={i === 0 ? 'Paste an email you wrote, greeting to sign-off.' : 'Another email'}
                className="max-h-56 min-h-28 pr-9"
              />
              {emails.length > 1 && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="absolute top-2 right-2 text-muted-foreground"
                  title="Remove"
                  onClick={() => setEmails(emails.filter((_, j) => j !== i))}
                >
                  <X />
                </Button>
              )}
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            {emails.length < 5 && (
              <Button variant="ghost" size="sm" onClick={() => setEmails([...emails, ''])}>
                <Plus /> Another email
              </Button>
            )}
            <Button variant="outline" size="sm" className="ml-auto" onClick={learn} disabled={learning || !pasted.length || !window.api}>
              {learning ? <Loader2 className="animate-spin" /> : <Sparkles />} {rules ? 'Learn again' : 'Learn my style'}
            </Button>
          </div>
          {error && (
            <p className="flex items-start gap-2 text-sm text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          )}
          {rules && (
            <div className="grid gap-2">
              <Label>Your style rules</Label>
              <ul className="divide-y rounded-lg border text-sm">
                {rules.length === 0 && <li className="px-3 py-2 text-muted-foreground">No rules. Add your own below.</li>}
                {rules.map((r, i) => (
                  <li key={i} className="group flex items-start gap-2 px-3 py-2">
                    <span className="flex-1">{r}</span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      title="Remove rule"
                      onClick={() => setRules(rules.filter((_, j) => j !== i))}
                    >
                      <X />
                    </Button>
                  </li>
                ))}
              </ul>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!newRule.trim()) return
                  setRules([...rules, newRule.trim()])
                  setNewRule('')
                }}
              >
                <Input value={newRule} onChange={(e) => setNewRule(e.target.value)} placeholder="Add a rule" className="h-8" />
                <Button type="submit" variant="outline" size="sm" disabled={!newRule.trim()}>
                  <Plus /> Add
                </Button>
              </form>
            </div>
          )}
        </div>
      ),
    },
    {
      title: 'Connect your mailbox',
      description:
        'Inroad saves each email to your Drafts folder so you can send it from your normal mail app. It never sends anything itself. You can skip this and do it later.',
      canContinue: true,
      next: mailConnected ? 'Start adding organisations' : 'Skip and start adding organisations',
      body: mailConnected ? (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
          <Check className="size-5 text-success" />
          <span className="flex-1">Connected as {settings?.mail?.fromEmail}. You can change this later in Settings.</span>
        </div>
      ) : (
        <MailboxForm settings={settings} onSaved={onSettings} />
      ),
    },
  ]

  const current = steps[step]
  const last = step === steps.length - 1

  return (
    <div className="flex h-svh flex-col bg-background">
      {/* Window drag area, with room for the macOS traffic lights. */}
      <div className="drag flex h-12 shrink-0 items-center justify-end px-4">
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onSkip}>
          Skip setup
        </Button>
      </div>
      {welcome ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
          <img src={icon} alt="" width={112} height={112} className="mb-6 select-none" draggable={false} />
          <h1 className="font-heading text-3xl font-semibold">Welcome to Inroad</h1>
          <p className="mt-3 max-w-md text-balance text-muted-foreground">
            Research and draft personalised outreach emails in bulk, in your own voice. Add the organisations you want to reach: the AI agent researches each
            one, writes an email that sounds like you, and saves it to your Drafts folder for you to send.
          </p>
          <Button size="lg" className="mt-8" autoFocus onClick={() => setConnecting(true)}>
            Get started <ArrowRight />
          </Button>
          <ClaudeSetupDialog
            open={connecting}
            onOpenChange={setConnecting}
            settings={settings}
            onSettings={onSettings}
            onDone={() => {
              setConnecting(false)
              setWelcome(false)
            }}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-xl flex-col px-6 pt-6 pb-10">
            <div className="mb-6 flex gap-1.5" aria-label={`Step ${step + 1} of ${steps.length}`}>
              {steps.map((_, i) => (
                <span key={i} className={cn('h-1 flex-1 rounded-full', i <= step ? 'bg-primary' : 'bg-muted')} />
              ))}
            </div>
            <h1 className="font-heading text-2xl font-semibold">{current.title}</h1>
            <p className="mt-1 mb-6 text-muted-foreground">{current.description}</p>
            {current.body}
            <div className="mt-8 flex items-center gap-2">
              <Button variant="ghost" onClick={() => (step > 0 ? setStep(step - 1) : setWelcome(true))}>
                <ArrowLeft /> Back
              </Button>
              <Button className="ml-auto" disabled={!current.canContinue} onClick={() => (last ? finish() : setStep(step + 1))}>
                {current.next ?? 'Continue'} {!last && <ArrowRight />}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
