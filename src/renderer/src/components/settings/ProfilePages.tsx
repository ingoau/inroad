import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Mail, Paperclip, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { MAX_VOICE_EXAMPLES, type Campaign, type Folder, type Voice } from '../../data'
import { FolderFields } from '../FolderFields'
import { ButtonKeys } from '../hint'
import { Intro } from './GeneralPages'
import { SettingsBlock, SettingsRow, SettingsSection } from './layout'

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

export function FolderPage({ folder, campaigns, onUpdate }: { folder: Folder; campaigns: Campaign[]; onUpdate: (patch: Partial<Folder>) => void }) {
  const count = campaigns.filter((c) => c.folderId === folder.id).length
  return (
    <>
      <Intro>
        Context the {count === 1 ? 'campaign' : `${count} campaigns`} in this folder share, usually the event. Each campaign’s notes then say what you’re asking
        that group for.
      </Intro>
      <SettingsSection>
        <SettingsBlock>
          <FolderFields key={folder.id} folder={folder} onChange={onUpdate} autoFocus={!folder.name} />
        </SettingsBlock>
      </SettingsSection>
    </>
  )
}

export function CampaignPage({
  campaign,
  folders,
  voices,
  onUpdate,
  onAttach,
  onRemoveAttachment,
}: {
  campaign: Campaign
  folders: Folder[]
  voices: Voice[]
  onUpdate: (patch: Partial<Campaign>) => void
  onAttach: () => void
  onRemoveAttachment: (id: string) => void
}) {
  return (
    <>
      <SettingsSection>
        <SettingsRow title="Name" htmlFor="campaign-name">
          <Input
            id="campaign-name"
            className="w-64"
            value={campaign.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder="e.g. Sponsors"
            autoFocus={!campaign.name}
          />
        </SettingsRow>
        {folders.length > 1 && (
          <SettingsRow title="Folder" description="Campaigns read their folder’s shared context.">
            <Select value={campaign.folderId} onValueChange={(folderId) => onUpdate({ folderId })}>
              <SelectTrigger className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {folders.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name || 'Untitled folder'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsRow>
        )}
        <SettingsRow title="Drafting" description="Research-only campaigns get a brief for each organisation, and you write emails one at a time when you want them.">
          <Select value={campaign.researchOnly ? 'research' : 'draft'} onValueChange={(v) => onUpdate({ researchOnly: v === 'research' })}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="draft">Research and draft emails</SelectItem>
              <SelectItem value="research">Research only</SelectItem>
            </SelectContent>
          </Select>
        </SettingsRow>
        <SettingsRow title="Voice" description="Whose writing style drafts in this campaign use.">
          <Select value={campaign.voiceId} onValueChange={(voiceId) => onUpdate({ voiceId })}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {voices.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name || 'Untitled voice'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Notes">
        <SettingsRow
          stacked
          title="What you’re asking for"
          description={`Who you’re contacting and what you’re asking them for, what the AI should look for when researching each one, and anything about tone. The AI reads this after the folder’s shared context.`}
        >
          <Textarea
            value={campaign.notes}
            onChange={(e) => onUpdate({ notes: e.target.value })}
            placeholder="e.g. Local cafés and restaurants for catering. Asking for 3 meals a day for 400 people at a discount, in exchange for branding. Look for ones that have catered big events."
            className="min-h-56 leading-relaxed"
          />
        </SettingsRow>
        <SettingsRow
          stacked
          title="Email format"
          description="The structure and must-haves for every email in this campaign. The AI treats this as a requirement, where the notes above are context."
        >
          <Textarea
            value={campaign.format ?? ''}
            onChange={(e) => onUpdate({ format: e.target.value })}
            placeholder={
              'e.g. One-line intro, then why them, then the ask (Gold tier, $5k) with a link to the prospectus. Under 150 words. End with a question.'
            }
            className="min-h-28 leading-relaxed"
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Attachments">
        <SettingsRow title="Attached to every email" description="Added when each email is saved to Drafts. The AI knows what’s attached.">
          <Button variant="outline" size="sm" onClick={onAttach} disabled={!window.api}>
            <Paperclip /> Attach file
          </Button>
        </SettingsRow>
        {campaign.attachments.length > 0 && (
          <SettingsBlock className="flex flex-wrap gap-2">
            {campaign.attachments.map((a) => (
              <Badge key={a.id} variant="secondary" className="gap-1.5 pr-1 font-normal">
                <Paperclip className="size-3" />
                {a.name}
                <span className="text-muted-foreground">{kb(a.size)}</span>
                <button onClick={() => onRemoveAttachment(a.id)} className="opacity-60 hover:opacity-100" title={`Remove ${a.name}`}>
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </SettingsBlock>
        )}
      </SettingsSection>
    </>
  )
}

export function VoicePage({
  voice,
  onUpdate,
  onAddNote,
  onDeleteNote,
  onAddExample,
  onDeleteExample,
}: {
  voice: Voice
  onUpdate: (patch: Partial<Voice>) => void
  onAddNote: (note: string) => void
  onDeleteNote: (note: string) => void
  onAddExample: (email: string) => void
  onDeleteExample: (id: string) => void
}) {
  const [note, setNote] = useState('')
  const [pasting, setPasting] = useState(false)
  const [email, setEmail] = useState('')
  const notes = voice.notes.filter((n) => !n.deletedAt)
  const examples = (voice.examples ?? []).filter((e) => !e.deletedAt)
  const pasted = examples.filter((e) => !e.draft)
  const learned = examples.filter((e) => e.draft)

  const addNote = () => {
    if (!note.trim()) return
    onAddNote(note.trim())
    setNote('')
  }
  const addEmail = () => {
    if (!email.trim()) return
    onAddExample(email.trim())
    setEmail('')
    setPasting(false)
  }

  return (
    <>
      <Intro>Learns from the edits you make before saving, and from emails you paste below.</Intro>
      <SettingsSection>
        <SettingsRow title="Name" htmlFor="voice-name">
          <Input
            id="voice-name"
            className="w-64"
            value={voice.name}
            onChange={(e) => onUpdate({ name: e.target.value })}
            placeholder="e.g. Formal"
            autoFocus={!voice.name}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Style notes">
        {notes.length === 0 && <SettingsBlock className="text-sm text-muted-foreground">No style notes yet.</SettingsBlock>}
        {notes.map((n) => (
          <div key={n.text} className="group flex items-start gap-2 px-4 py-2.5 text-sm">
            <span className="flex-1">{n.text}</span>
            {n.fresh && <Badge className="shrink-0 bg-mark font-normal text-black">New</Badge>}
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              title="Remove note"
              onClick={() => onDeleteNote(n.text)}
            >
              <X />
            </Button>
          </div>
        ))}
        <SettingsBlock>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              addNote()
            }}
          >
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note, e.g. Never use exclamation marks" />
            <Button type="submit" variant="outline" disabled={!note.trim()}>
              <Plus /> Add
            </Button>
          </form>
        </SettingsBlock>
      </SettingsSection>

      <SettingsSection
        title="Example emails"
        description={`The AI sees every email you paste here, plus your ${MAX_VOICE_EXAMPLES} most recent edited emails${learned.length ? ` (${learned.length} so far)` : ''}.`}
      >
        {pasted.map((e) => (
          <div key={e.id} className="group flex items-start gap-2 px-4 py-2.5 text-sm">
            <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="line-clamp-2 flex-1 text-muted-foreground">{e.final}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
              title="Delete example"
              onClick={() => onDeleteExample(e.id)}
            >
              <X />
            </Button>
          </div>
        ))}
        <SettingsBlock>
          {pasting ? (
            <div className="grid gap-2">
              <Textarea
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && addEmail()}
                placeholder="Paste an email you wrote, greeting to sign-off."
                className="min-h-40"
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPasting(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={addEmail} disabled={!email.trim()}>
                  Add example <ButtonKeys keys="⌘ ↵" primary />
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setPasting(true)}>
              <Plus /> Paste an email
            </Button>
          )}
        </SettingsBlock>
      </SettingsSection>
    </>
  )
}
