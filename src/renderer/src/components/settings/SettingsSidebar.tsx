import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
} from '@/components/ui/sidebar'
import {
  ArrowLeft,
  Bot,
  Database,
  Flag,
  FolderOpen,
  FolderPlus,
  Keyboard,
  Mail,
  Palette,
  PenLine,
  Plus,
  Search,
  Slash,
  Trash2,
  Type,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import type { Campaign, Folder, Voice } from '../../data'
import { Keys } from '../hint'

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

// Replaces the app sidebar while Settings is open (like T3 Code): settings
// categories, then folders with their campaigns, then voices.
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

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="drag">
        <div className="relative group-data-[collapsible=icon]:hidden">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
          <SidebarInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search settings" className="pl-8" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {general.length > 0 && (
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {general.map(({ kind, title, Icon }) => (
                  <SidebarMenuItem key={kind}>
                    <SidebarMenuButton isActive={is(kind)} tooltip={title} onClick={() => onPage({ kind })}>
                      <Icon />
                      <span>{title}</span>
                    </SidebarMenuButton>
                    {kind === 'trash' && trashCount > 0 && <SidebarMenuBadge>{trashCount}</SidebarMenuBadge>}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {(shownFolders.length > 0 || !q) && (
          <SidebarGroup>
            <SidebarGroupLabel>Folders & campaigns</SidebarGroupLabel>
            <SidebarGroupAction title="New folder" onClick={onNewFolder}>
              <FolderPlus />
            </SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu>
                {shownFolders.map((f) => (
                  <SidebarMenuItem key={f.id}>
                    <SidebarMenuButton isActive={is('folder', f.id)} tooltip={f.name || 'Untitled folder'} onClick={() => onPage({ kind: 'folder', id: f.id })}>
                      <FolderOpen />
                      <span>{f.name || 'Untitled folder'}</span>
                    </SidebarMenuButton>
                    <SidebarMenuSub>
                      {campaigns
                        .filter((c) => c.folderId === f.id)
                        .map((c) => (
                          <SidebarMenuSubItem key={c.id}>
                            <SidebarMenuSubButton asChild isActive={is('campaign', c.id)}>
                              <button onClick={() => onPage({ kind: 'campaign', id: c.id })}>
                                <Flag />
                                <span>{c.name || 'Untitled campaign'}</span>
                              </button>
                            </SidebarMenuSubButton>
                          </SidebarMenuSubItem>
                        ))}
                      <SidebarMenuSubItem>
                        <SidebarMenuSubButton asChild className="text-muted-foreground">
                          <button onClick={() => onNewCampaign(f.id)}>
                            <Plus />
                            <span>New campaign</span>
                          </button>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    </SidebarMenuSub>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        {(shownVoices.length > 0 || !q) && (
          <SidebarGroup>
            <SidebarGroupLabel>Voices</SidebarGroupLabel>
            <SidebarGroupAction title="New voice" onClick={onNewVoice}>
              <Plus />
            </SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu>
                {shownVoices.map((v) => (
                  <SidebarMenuItem key={v.id}>
                    <SidebarMenuButton isActive={is('voice', v.id)} tooltip={v.name || 'Untitled voice'} onClick={() => onPage({ kind: 'voice', id: v.id })}>
                      <PenLine />
                      <span>{v.name || 'Untitled voice'}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Back (esc)" onClick={onBack} className="text-muted-foreground">
              <ArrowLeft />
              <span className="flex-1">Back</span>
              <Keys keys="esc" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
