import { Sidebar, SidebarContent, SidebarHeader, SidebarInput } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { Bot, Database, Keyboard, Mail, Palette, Slash, Trash2, Type, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import type { Campaign, Folder, Voice } from '../../data'
import { Shortcut } from '../hint'

export type SettingsPage =
  | { kind: 'mailbox' | 'email' | 'snippets' | 'claude' | 'appearance' | 'shortcuts' | 'trash' | 'data' }
  | { kind: 'folder' | 'campaign' | 'voice'; id: string }

export const GENERAL_PAGES: { kind: Exclude<SettingsPage['kind'], 'folder' | 'campaign' | 'voice'>; title: string; Icon: LucideIcon }[] = [
  { kind: 'mailbox', title: 'Mailbox', Icon: Mail },
  { kind: 'email', title: 'Email style', Icon: Type },
  { kind: 'snippets', title: 'Snippets', Icon: Slash },
  { kind: 'claude', title: 'AI agent', Icon: Bot },
  { kind: 'appearance', title: 'Appearance', Icon: Palette },
  { kind: 'shortcuts', title: 'Keyboard shortcuts', Icon: Keyboard },
  { kind: 'trash', title: 'Deleted items', Icon: Trash2 },
  { kind: 'data', title: 'Data', Icon: Database },
]

// Replaces the app sidebar while Settings is open: settings pages, then
// folders with their campaigns, then voices, as a plain list.
export function SettingsSidebar({
  page,
  onPage,
  onBack,
  folders,
  campaigns,
  voices,
  trashCount,
  onNewFolder,
  onNewCampaign,
  onNewVoice,
}: {
  page: SettingsPage
  onPage: (p: SettingsPage) => void
  onBack: () => void
  folders: Folder[]
  campaigns: Campaign[]
  voices: Voice[]
  trashCount: number
  onNewFolder: () => void
  onNewCampaign: (folderId: string) => void
  onNewVoice: () => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const matches = (s: string) => !q || s.toLowerCase().includes(q)
  const is = (kind: SettingsPage['kind'], id?: string) => page.kind === kind && (!id || ('id' in page && page.id === id))

  const general = GENERAL_PAGES.filter((p) => matches(p.title))
  // A folder shows if it or any of its campaigns match.
  const shownFolders = folders.filter((f) => matches(f.name || 'Untitled folder') || campaigns.some((c) => c.folderId === f.id && matches(c.name)))
  const shownVoices = voices.filter((v) => matches(v.name || 'Untitled voice'))

  const item = (active: boolean, extra = '') =>
    cn('block w-full truncate py-1 text-left text-sm transition-colors', active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground', extra)

  return (
    <Sidebar collapsible="offcanvas" className="border-r-0">
      <SidebarHeader className="drag gap-4 px-5 pt-6">
        <button onClick={onBack} className="text-left text-sm text-muted-foreground hover:text-foreground">
          ← Back <Shortcut keys="esc" />
        </button>
        <SidebarInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search settings" className="h-8 border-0 bg-muted/60 shadow-none" />
      </SidebarHeader>

      <SidebarContent className="gap-6 px-5 pt-2 pb-6">
        {general.length > 0 && (
          <nav aria-label="Settings">
            {general.map(({ kind, title }) => (
              <button key={kind} onClick={() => onPage({ kind })} className={item(is(kind))}>
                {title}
                {kind === 'trash' && trashCount > 0 && <span className="ml-1.5 text-muted-foreground/60">{trashCount}</span>}
              </button>
            ))}
          </nav>
        )}

        {(shownFolders.length > 0 || !q) && (
          <nav aria-label="Folders and campaigns" className="space-y-3">
            {shownFolders.map((f) => (
              <div key={f.id}>
                <button onClick={() => onPage({ kind: 'folder', id: f.id })} className={item(is('folder', f.id), 'text-xs')}>
                  {f.name || 'Untitled folder'}
                </button>
                {campaigns
                  .filter((c) => c.folderId === f.id)
                  .map((c) => (
                    <button key={c.id} onClick={() => onPage({ kind: 'campaign', id: c.id })} className={item(is('campaign', c.id), 'pl-3')}>
                      {c.name || 'Untitled campaign'}
                    </button>
                  ))}
                <button onClick={() => onNewCampaign(f.id)} className={item(false, 'pl-3 text-muted-foreground/60')}>
                  + New campaign
                </button>
              </div>
            ))}
            <button onClick={onNewFolder} className={item(false, 'text-muted-foreground/60')}>
              + New folder
            </button>
          </nav>
        )}

        {(shownVoices.length > 0 || !q) && (
          <nav aria-label="Voices">
            <div className="py-1 text-xs text-muted-foreground">Voices</div>
            {shownVoices.map((v) => (
              <button key={v.id} onClick={() => onPage({ kind: 'voice', id: v.id })} className={item(is('voice', v.id), 'pl-3')}>
                {v.name || 'Untitled voice'}
              </button>
            ))}
            <button onClick={onNewVoice} className={item(false, 'pl-3 text-muted-foreground/60')}>
              + New voice
            </button>
          </nav>
        )}
      </SidebarContent>
    </Sidebar>
  )
}
