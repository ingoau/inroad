import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { ChevronsUpDown, Flag, FolderOpen, FolderPlus, Keyboard, Moon, MoreHorizontal, Pencil, PenLine, Plus, Search, Settings2, Sun, Trash2 } from 'lucide-react'
import { useEffect } from 'react'
import type { Campaign, Folder, Prospect, Status, Voice } from '../data'
import { Keys } from './hint'
import { statusStyle } from './status'

export type Filter = 'all' | 'review' | 'saved'
export const inFilter: Record<Filter, (s: Status) => boolean> = {
  all: () => true,
  review: (s) => s === 'drafted' || s === 'edited' || s === 'failed',
  saved: (s) => s === 'saved',
}

interface Props {
  prospects: Prospect[]
  selectedId: string
  onSelect: (id: string) => void
  onAdd: () => void
  folders: Folder[]
  campaigns: Campaign[]
  // Every campaign's organisations (not deleted ones), for the campaign switcher counts.
  allProspects: Prospect[]
  campaignId: string
  onSwitchCampaign: (id: string) => void
  onEditCampaign: (id: string) => void
  onNewCampaign: () => void
  onEditFolder: (id: string) => void
  onNewFolder: () => void
  voices: Voice[]
  onDeleteProspect: (id: string) => void
  onDeleteCampaign: (id: string) => void
  onSetVoice: (voiceId: string) => void
  onEditVoices: () => void
  filter: Filter
  onFilter: (f: Filter) => void
  theme: 'dark' | 'light'
  onToggleTheme: () => void
  onOpenPalette: () => void
  onShowKeys: () => void
  trashCount: number
  // Undefined until a mailbox is connected.
  mailAddress?: string
  onOpenSettings: () => void
  onOpenTrash: () => void
}

const statusDot: Record<Status, string> = {
  queued: 'bg-muted-foreground/40',
  researching: 'bg-muted-foreground/60 animate-pulse',
  drafted: 'bg-primary',
  edited: 'bg-primary',
  saved: 'bg-success',
  failed: 'bg-destructive',
}

export function AppSidebar(props: Props) {
  const { prospects, selectedId, filter } = props
  const { isMobile, setOpenMobile } = useSidebar()
  const campaign = props.campaigns.find((c) => c.id === props.campaignId)!
  const folder = props.folders.find((f) => f.id === campaign.folderId)
  const { voices } = props
  const voice = voices.find((v) => v.id === campaign.voiceId) ?? voices[0]
  const shown = prospects.filter((p) => inFilter[filter](p.status))
  const count = (f: Filter) => prospects.filter((p) => inFilter[f](p.status)).length

  useEffect(() => {
    document.querySelector(`[data-prospect="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const select = (id: string) => {
    props.onSelect(id)
    if (isMobile) setOpenMobile(false)
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="drag">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" tooltip={campaign.name || 'Campaign'}>
                  <div className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
                    <Flag className="size-4" />
                  </div>
                  <div className="grid flex-1 text-left leading-tight">
                    <span className="truncate font-heading font-semibold">{campaign.name || 'Untitled campaign'}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {folder?.name ? `${folder.name} · ` : ''}
                      {prospects.length} organisations
                    </span>
                  </div>
                  <ChevronsUpDown className="ml-auto" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side={isMobile ? 'bottom' : 'right'} className="max-h-[70vh] w-64">
                {/* Campaigns grouped under their folder. */}
                <DropdownMenuRadioGroup value={props.campaignId} onValueChange={props.onSwitchCampaign}>
                  {props.folders.map((f, i) => {
                    const inFolder = props.campaigns.filter((c) => c.folderId === f.id)
                    if (!inFolder.length) return null
                    return (
                      <DropdownMenuGroup key={f.id}>
                        {i > 0 && <DropdownMenuSeparator />}
                        <DropdownMenuLabel className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <FolderOpen className="size-3.5" />
                          <span className="truncate">{f.name || 'Untitled folder'}</span>
                        </DropdownMenuLabel>
                        {inFolder.map((c) => (
                          <DropdownMenuRadioItem key={c.id} value={c.id}>
                            <span className="flex-1 truncate">{c.name || 'Untitled campaign'}</span>
                            <span className="text-xs text-muted-foreground">{props.allProspects.filter((p) => p.campaignId === c.id).length}</span>
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuGroup>
                    )
                  })}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => props.onEditCampaign(props.campaignId)}>
                  <Pencil /> Edit campaign notes
                </DropdownMenuItem>
                {folder && (
                  <DropdownMenuItem onSelect={() => props.onEditFolder(folder.id)}>
                    <FolderOpen /> Edit {folder.name || 'folder'} context
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={props.onNewCampaign}>
                  <Plus /> New campaign{folder?.name ? ` in ${folder.name}` : ''}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={props.onNewFolder}>
                  <FolderPlus /> New folder
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={props.campaigns.length < 2} onSelect={() => props.onDeleteCampaign(props.campaignId)}>
                  <Trash2 /> Delete campaign
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>

          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton tooltip={`Writing as ${voice.name}`}>
                  <PenLine />
                  <span className="truncate text-muted-foreground">
                    Writing as <span className="font-medium text-foreground">{voice.name}</span>
                  </span>
                  <ChevronsUpDown className="ml-auto text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side={isMobile ? 'bottom' : 'right'} className="w-64">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Voice for this campaign</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={voice.id} onValueChange={props.onSetVoice}>
                  {voices.map((v) => (
                    <DropdownMenuRadioItem key={v.id} value={v.id}>
                      <span className="flex flex-col">
                        <span>{v.name}</span>
                        <span className="text-xs text-muted-foreground">{v.description}</span>
                      </span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={props.onEditVoices}>
                  <Settings2 /> Edit voices…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>

          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Search & commands (⌘K)" onClick={props.onOpenPalette} className="text-muted-foreground">
              <Search />
              <span>Search & commands</span>
              <Keys keys="⌘ K" className="ml-auto" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Organisations</SidebarGroupLabel>
          <SidebarGroupAction title="Add to campaign (C)" onClick={props.onAdd}>
            <Plus />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <Tabs value={filter} onValueChange={(v) => props.onFilter(v as Filter)} className="mb-2 group-data-[collapsible=icon]:hidden">
              <TabsList className="w-full">
                {(['all', 'review', 'saved'] as Filter[]).map((f) => (
                  <TabsTrigger key={f} value={f} className="gap-1 px-1.5 text-xs">
                    {{ all: 'All', review: 'Review', saved: 'Saved' }[f]}
                    <span className="text-muted-foreground">{count(f)}</span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <SidebarMenu>
              {shown.map((p) => (
                <SidebarMenuItem key={p.id}>
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <SidebarMenuButton
                        size="lg"
                        data-prospect={p.id}
                        isActive={p.id === selectedId}
                        onClick={() => select(p.id)}
                        tooltip={`${p.company} · ${statusStyle[p.status].label}`}
                      >
                        <div className="relative grid size-8 shrink-0 place-items-center rounded-md bg-muted text-xs font-semibold text-muted-foreground group-data-[active=true]/menu-button:bg-background group-data-[active=true]/menu-button:text-foreground">
                          {p.company[0]}
                          {/* Collapsed sidebar only: the status line is hidden there, so a dot stands in for it. */}
                          <span
                            className={cn('absolute top-1 right-1 hidden size-1.5 rounded-full group-data-[collapsible=icon]:block', statusDot[p.status])}
                          />
                        </div>
                        <div className="grid min-w-0 flex-1 leading-tight">
                          <span className="truncate font-medium">{p.company}</span>
                          <span
                            className={cn(
                              'truncate text-xs',
                              p.status === 'saved' || p.status === 'failed' ? statusStyle[p.status].tone : 'text-muted-foreground',
                            )}
                          >
                            {p.status === 'researching' ? (p.subagents?.some((r) => !r.done) ? `${p.subagents.filter((r) => !r.done).length} sub-agents researching` : (p.progress.at(-1) ?? 'Starting…')) : statusStyle[p.status].label}
                          </span>
                        </div>
                      </SidebarMenuButton>
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-48">
                      <ContextMenuItem onSelect={() => select(p.id)}>Open</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" onSelect={() => props.onDeleteProspect(p.id)}>
                        <Trash2 /> Delete
                        <ContextMenuShortcut>⌫</ContextMenuShortcut>
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <SidebarMenuAction showOnHover className="top-3.5!">
                        <MoreHorizontal />
                        <span className="sr-only">More</span>
                      </SidebarMenuAction>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent side="right" align="start" className="w-48">
                      <DropdownMenuItem variant="destructive" onSelect={() => props.onDeleteProspect(p.id)}>
                        <Trash2 /> Delete {p.company}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
            {shown.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">Nothing here.</p>}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      {/* Everything that isn't about the emails themselves lives in one menu. */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  tooltip={props.mailAddress ?? 'Connect your mailbox'}
                  className="data-[state=open]:bg-sidebar-accent"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-md bg-sidebar-accent">
                    <span className={cn('size-2 rounded-full', props.mailAddress ? 'bg-success' : 'bg-muted-foreground/50')} />
                  </span>
                  <span className="grid min-w-0 flex-1 text-left leading-tight">
                    <span className="truncate text-sm">{props.mailAddress ?? 'No mailbox'}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {props.mailAddress ? 'Saving to Drafts' : 'Connect to save drafts'}
                    </span>
                  </span>
                  <ChevronsUpDown className="ml-auto text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side={isMobile ? 'top' : 'right'} align="end" className="w-60">
                <DropdownMenuItem onSelect={props.onOpenSettings}>
                  <Settings2 /> Settings
                  <DropdownMenuShortcut>⌘,</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={props.onOpenTrash}>
                  <Trash2 /> Deleted items
                  {props.trashCount > 0 && <DropdownMenuShortcut>{props.trashCount}</DropdownMenuShortcut>}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={props.onShowKeys}>
                  <Keyboard /> Keyboard shortcuts
                  <DropdownMenuShortcut>?</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={props.onToggleTheme}>
                  {props.theme === 'dark' ? <Sun /> : <Moon />} {props.theme === 'dark' ? 'Light mode' : 'Dark mode'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
