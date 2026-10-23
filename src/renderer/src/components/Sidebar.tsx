import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '@/components/ui/command'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuShortcut, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, useSidebar } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import { Loader2, Sparkles, Trash2 } from 'lucide-react'
import { useEffect } from 'react'
import { hasEmail, type Campaign, type Folder, type Prospect, type Voice } from '../data'
import { Shortcut } from './hint'

// The sidebar list's filters. "To write" is research-only organisations whose
// email nobody has written yet; "To review" has a draft (or needs attention).
export type Filter = 'review' | 'write' | 'all' | 'saved'
const toWrite = (p: Prospect) => p.status === 'researched' || (p.status === 'edited' && !p.originalBody)
export const inFilter: Record<Filter, (p: Prospect) => boolean> = {
  review: (p) => p.status === 'failed' || (hasEmail(p) && p.status !== 'saved' && !toWrite(p)),
  write: toWrite,
  all: () => true,
  saved: (p) => p.status === 'saved',
}
export const FILTERS: [Filter, string][] = [
  ['review', 'To review'],
  ['write', 'To write'],
  ['all', 'All'],
  ['saved', 'Saved'],
]

// A dot per organisation: the only status shown in the list (and in ⌘K).
export const dot = (p: Prospect) =>
  p.status === 'saved'
    ? 'bg-success'
    : p.status === 'failed'
      ? 'bg-destructive'
      : p.status === 'researching'
        ? 'bg-muted-foreground/50 animate-pulse'
        : p.status === 'queued'
          ? 'bg-muted-foreground/30'
          : toWrite(p)
            ? 'bg-mark'
            : 'bg-foreground'

interface Props {
  prospects: Prospect[]
  selectedId: string
  onSelect: (id: string) => void
  onAdd: () => void
  // "Find with AI" for this campaign, while it's searching or has suggestions
  // left to look at. Hidden on the Add page itself.
  discovery?: { searching: boolean; count: number }
  onOpenDiscovery: () => void
  onDeleteProspect: (id: string) => void
  filter: Filter
  onFilter: (f: Filter) => void
  onOpenPalette: () => void
  onOpenSettings: () => void
  // Only shown when the mailbox isn't connected yet.
  mailReady: boolean
  onConnectMail: () => void
  switcher: SwitcherProps
}

export function AppSidebar(props: Props) {
  const { prospects, selectedId, filter } = props
  const { isMobile, setOpenMobile } = useSidebar()
  const shown = prospects.filter(inFilter[filter])
  const count = (f: Filter) => prospects.filter(inFilter[f]).length
  const researching = prospects.filter((p) => p.status === 'researching' || p.status === 'queued').length
  const saved = count('saved')

  useEffect(() => {
    document.querySelector(`[data-prospect="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const select = (id: string) => {
    props.onSelect(id)
    if (isMobile) setOpenMobile(false)
  }

  return (
    <Sidebar collapsible="offcanvas" className="border-r-0">
      <SidebarHeader className="drag gap-4 px-5 pt-6">
        <CampaignSwitcher {...props.switcher} />
        <button
          onClick={props.onOpenPalette}
          className="flex h-8 items-center rounded-lg bg-muted/60 px-3 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"
        >
          Search
          <Shortcut keys="⌘K" className="ml-auto" />
        </button>
      </SidebarHeader>

      <SidebarContent className="px-5">
        <div role="tablist" aria-label="Filter" className="flex gap-x-3 pt-2 pb-3 text-[13px] whitespace-nowrap">
          {FILTERS.map(([f, label]) => (
            <button
              key={f}
              role="tab"
              aria-selected={filter === f}
              onClick={() => props.onFilter(f)}
              className={cn(
                'py-0.5 text-muted-foreground transition-colors hover:text-foreground',
                filter === f && 'text-foreground shadow-[inset_0_-1px_0_currentColor]',
              )}
            >
              {label} <span className="text-muted-foreground/60">{count(f)}</span>
            </button>
          ))}
        </div>
        <nav aria-label="Organisations" className="flex flex-col">
          {shown.map((p) => (
            <ContextMenu key={p.id}>
              <ContextMenuTrigger asChild>
                <button
                  data-prospect={p.id}
                  onClick={() => select(p.id)}
                  className={cn(
                    'flex min-w-0 items-center gap-2.5 rounded-md py-1.5 text-left text-sm transition-colors',
                    p.id === selectedId ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span className={cn('size-1.5 shrink-0 rounded-full', dot(p))} />
                  <span className="truncate">{p.company}</span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-48">
                <ContextMenuItem variant="destructive" onSelect={() => props.onDeleteProspect(p.id)}>
                  <Trash2 /> Delete
                  <ContextMenuShortcut>⌫</ContextMenuShortcut>
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </nav>
        {shown.length === 0 && (
          <p className="py-1.5 text-sm text-muted-foreground">{prospects.length ? 'Nothing here.' : 'No organisations yet.'}</p>
        )}
        {(researching > 0 || (saved > 0 && filter !== 'saved')) && (
          <p className="pt-3 text-xs text-muted-foreground/70">
            {[researching && `${researching} researching`, saved && filter !== 'saved' && `${saved} in Drafts`].filter(Boolean).join(' · ')}
          </p>
        )}
      </SidebarContent>

      <SidebarFooter className="gap-2 px-5 pb-6 text-sm">
        {!props.mailReady && (
          <button onClick={props.onConnectMail} className="text-left text-mark-text hover:underline">
            Connect your mailbox
          </button>
        )}
        {props.discovery && (
          <button
            onClick={props.onOpenDiscovery}
            className="-mx-2 mb-1 flex items-center gap-2 rounded-lg bg-muted/60 px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted"
          >
            {props.discovery.searching ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            ) : (
              <Sparkles className="size-3.5 text-muted-foreground" />
            )}
            {props.discovery.searching ? 'Finding organisations' : 'Suggestions'}
            {props.discovery.count > 0 && <span className="ml-auto text-muted-foreground">{props.discovery.count} new</span>}
          </button>
        )}
        <button onClick={props.onAdd} className="text-left text-muted-foreground hover:text-foreground">
          + Add organisations <Shortcut keys="⌘N" />
        </button>
        <button onClick={props.onOpenSettings} className="text-left text-muted-foreground hover:text-foreground">
          Settings <Shortcut keys="⌘," />
        </button>
      </SidebarFooter>
    </Sidebar>
  )
}

// ---------------------------------------------------------- campaign switcher

export interface SwitcherProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  folders: Folder[]
  campaigns: Campaign[]
  // Every campaign's organisations (not deleted ones), for the counts.
  allProspects: Prospect[]
  campaignId: string
  voices: Voice[]
  onSwitchCampaign: (id: string) => void
  onEditCampaign: (id: string) => void
  onEditFolder: (id: string) => void
  onNewCampaign: () => void
  onNewFolder: () => void
  onSetVoice: (id: string) => void
}

// The campaign name at the top of the sidebar; click it or press ⌘O to switch
// campaign, jump between folders, or start a new one.
function CampaignSwitcher(props: SwitcherProps) {
  // On phones the sidebar is a sheet; open it so there's something to hang the switcher off.
  const { isMobile, setOpenMobile } = useSidebar()
  useEffect(() => {
    if (props.open && isMobile) setOpenMobile(true)
  }, [props.open, isMobile, setOpenMobile])
  const campaign = props.campaigns.find((c) => c.id === props.campaignId)!
  const folder = props.folders.find((f) => f.id === campaign.folderId)
  const voice = props.voices.find((v) => v.id === campaign.voiceId) ?? props.voices[0]
  const run = (fn: () => void) => () => {
    props.onOpenChange(false)
    fn()
  }
  // What's left to do in a campaign, e.g. "2 to review".
  const meta = (c: Campaign) => {
    const ps = props.allProspects.filter((p) => p.campaignId === c.id)
    if (!ps.length) return 'empty'
    const review = ps.filter(inFilter.review).length
    const write = ps.filter(inFilter.write).length
    if (review) return `${review} to review`
    if (write) return `${write} to write`
    if (ps.some((p) => p.status === 'researching' || p.status === 'queued')) return 'researching'
    return 'all saved'
  }

  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger asChild>
        <button className="-mx-1.5 -my-1 flex min-w-0 flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-left outline-none focus-visible:bg-muted/60">
          <span className="flex max-w-full items-center gap-1.5 font-heading font-semibold">
            <span className="truncate">{campaign.name || 'Untitled campaign'}</span>
            <span className="text-xs font-normal text-muted-foreground">⌄</span>
          </span>
          <span className="flex max-w-full items-center text-sm text-muted-foreground">
            <span className="truncate">{folder?.name || 'Untitled folder'}</span>
            <Shortcut keys="⌘O" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={8} className="w-80 p-0" onCloseAutoFocus={(e) => e.preventDefault()}>
        <Command>
          <CommandInput placeholder="Go to a campaign…" />
          <CommandList className="max-h-[60vh]">
            <CommandEmpty>No campaigns match.</CommandEmpty>
            {props.folders.map((f) => {
              const inFolder = props.campaigns.filter((c) => c.folderId === f.id)
              if (!inFolder.length) return null
              return (
                <CommandGroup key={f.id} heading={f.name || 'Untitled folder'}>
                  {inFolder.map((c) => (
                    <CommandItem
                      key={c.id}
                      value={`${c.id} ${c.name} ${f.name}`}
                      onSelect={run(() => props.onSwitchCampaign(c.id))}
                      data-checked={c.id === campaign.id}
                      className={cn(c.id === campaign.id && 'font-medium')}
                    >
                      <span className="truncate">{c.name || 'Untitled campaign'}</span>
                      <CommandShortcut className="tracking-normal">{meta(c)}</CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )
            })}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem onSelect={run(props.onNewCampaign)}>New campaign{folder?.name ? ` in ${folder.name}` : ''}</CommandItem>
              <CommandItem onSelect={run(props.onNewFolder)}>New folder</CommandItem>
              <CommandItem onSelect={run(() => props.onEditCampaign(campaign.id))}>Edit {campaign.name || 'campaign'} notes & format</CommandItem>
              {folder && <CommandItem onSelect={run(() => props.onEditFolder(folder.id))}>Edit {folder.name || 'folder'} context</CommandItem>}
            </CommandGroup>
            {props.voices.length > 1 && (
              <>
                <CommandSeparator />
                <CommandGroup heading={`Writing as ${voice.name}`}>
                  {props.voices
                    .filter((v) => v.id !== voice.id)
                    .map((v) => (
                      <CommandItem key={v.id} value={`voice ${v.name}`} onSelect={run(() => props.onSetVoice(v.id))}>
                        Write as {v.name}
                      </CommandItem>
                    ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
