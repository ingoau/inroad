import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Plus, Trash2 } from 'lucide-react'
import type { Campaign, Folder, Snippet } from '../../data'
import { Intro } from './GeneralPages'
import { SettingsBlock, SettingsSection } from './layout'

// A snippet's scope as one Select value: "global", "folder:<id>" or "campaign:<id>".
const scopeValue = (s: Snippet['scope']) => (s.kind === 'global' ? 'global' : `${s.kind}:${s.id}`)
function parseScope(v: string): Snippet['scope'] {
  const [kind, id] = v.split(':')
  return kind === 'folder' || kind === 'campaign' ? { kind, id } : { kind: 'global' }
}

export function SnippetsPage({
  snippets,
  folders,
  campaigns,
  onAdd,
  onUpdate,
  onDelete,
}: {
  snippets: Snippet[]
  folders: Folder[]
  campaigns: Campaign[]
  onAdd: () => void
  onUpdate: (id: string, patch: Partial<Snippet>) => void
  onDelete: (id: string) => void
}) {
  const folderName = (id: string) => folders.find((f) => f.id === id)?.name || 'Untitled folder'
  return (
    <>
      <Intro>
        Text you use again and again: sponsor tiers, a sign-off, a paragraph about your event. Type <kbd className="rounded bg-muted px-1">/</kbd> in an email
        to insert one, or select text in an email and choose Save as snippet. Each one works everywhere, in one folder’s campaigns, or in one campaign.
      </Intro>
      <div>
        <Button variant="outline" onClick={onAdd}>
          <Plus /> New snippet
        </Button>
      </div>
      {snippets.map((s) => {
        // A folder or campaign that's since been deleted still shows, so it can be changed.
        const scope = scopeValue(s.scope)
        const known = scope === 'global' || folders.some((f) => `folder:${f.id}` === scope) || campaigns.some((c) => `campaign:${c.id}` === scope)
        return (
          <SettingsSection key={s.id}>
            <SettingsBlock className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={s.name}
                  onChange={(e) => onUpdate(s.id, { name: e.target.value })}
                  placeholder="Name, e.g. Sponsor tiers"
                  aria-label="Snippet name"
                  autoFocus={!s.name && !s.text}
                  className="min-w-40 flex-1"
                />
                <Select value={scope} onValueChange={(v) => onUpdate(s.id, { scope: parseScope(v) })}>
                  <SelectTrigger className="w-56" aria-label="Where it can be used">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">Everywhere</SelectItem>
                    {folders.map((f) => (
                      <SelectItem key={f.id} value={`folder:${f.id}`}>
                        {f.name || 'Untitled folder'} folder
                      </SelectItem>
                    ))}
                    {campaigns.map((c) => (
                      <SelectItem key={c.id} value={`campaign:${c.id}`}>
                        {c.name || 'Untitled campaign'} <span className="text-muted-foreground">· {folderName(c.folderId)}</span>
                      </SelectItem>
                    ))}
                    {!known && <SelectItem value={scope}>A deleted {s.scope.kind}</SelectItem>}
                  </SelectContent>
                </Select>
                <Button variant="ghost" size="icon-sm" title="Delete snippet" className="text-muted-foreground hover:text-destructive" onClick={() => onDelete(s.id)}>
                  <Trash2 />
                </Button>
              </div>
              <Textarea
                value={s.text}
                onChange={(e) => onUpdate(s.id, { text: e.target.value })}
                placeholder="The text to insert. **bold**, *italic* and [links](https://…) work."
                className="min-h-24 leading-relaxed"
              />
            </SettingsBlock>
          </SettingsSection>
        )
      })}
      {snippets.length === 0 && <p className="px-1 text-sm text-muted-foreground">No snippets yet.</p>}
    </>
  )
}
