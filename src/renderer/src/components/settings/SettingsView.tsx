import { Button } from '@/components/ui/button'
import { ChevronRight, Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { PublicSettings } from '../../../../shared/api'
import type { Campaign, Folder, Snippet, Voice } from '../../data'
import type { EmailStyle } from '../../markdown'
import { TopBar } from '../TopBar'
import { TrashView, type TrashItem } from '../TrashView'
import { AppearancePage, ClaudePage, DataPage, EmailStylePage, Intro, MailboxPage, ShortcutsPage } from './GeneralPages'
import { CampaignPage, FolderPage, VoicePage } from './ProfilePages'
import { GENERAL_PAGES, type SettingsPage } from './SettingsSidebar'
import { SnippetsPage } from './SnippetsPage'

export interface SettingsViewProps {
  page: SettingsPage
  onPage: (p: SettingsPage) => void
  settings: PublicSettings | null
  onSettings: (s: PublicSettings) => void
  emailStyle: EmailStyle
  onEmailStyle: (s: EmailStyle) => void
  theme: 'dark' | 'light'
  onTheme: (t: 'dark' | 'light') => void
  trash: TrashItem[]
  onRestore: (item: TrashItem) => void
  onPurge: (item: TrashItem) => void
  onEmptyTrash: () => void
  onReset: () => void
  folders: Folder[]
  campaigns: Campaign[]
  voices: Voice[]
  onUpdateFolder: (id: string, patch: Partial<Folder>) => void
  onDeleteFolder: (id: string) => void
  onUpdateCampaign: (id: string, patch: Partial<Campaign>) => void
  onDeleteCampaign: (id: string) => void
  onAttach: (campaignId: string) => void
  onRemoveAttachment: (campaignId: string, attachmentId: string) => void
  onUpdateVoice: (id: string, patch: Partial<Voice>) => void
  onDeleteVoice: (id: string) => void
  onAddVoiceNote: (voiceId: string, note: string) => void
  onDeleteVoiceNote: (voiceId: string, note: string) => void
  onAddExample: (voiceId: string, email: string) => void
  onDeleteExample: (voiceId: string, exampleId: string) => void
  snippets: Snippet[]
  onAddSnippet: () => void
  onUpdateSnippet: (id: string, patch: Partial<Snippet>) => void
  onDeleteSnippet: (id: string) => void
}

export function SettingsView(props: SettingsViewProps) {
  const { page, folders, campaigns, voices } = props
  const id = 'id' in page ? page.id : ''
  const folder = page.kind === 'folder' ? folders.find((f) => f.id === id) : undefined
  const campaign = page.kind === 'campaign' ? campaigns.find((c) => c.id === id) : undefined
  const voice = page.kind === 'voice' ? voices.find((v) => v.id === id) : undefined
  const campaignFolder = campaign && folders.find((f) => f.id === campaign.folderId)

  // Breadcrumb after "Settings", plus a Delete button for things that can be deleted.
  let crumbs: ReactNode[] = []
  let onDelete: (() => void) | undefined
  let canDelete = false
  let body: ReactNode
  if (folder) {
    crumbs = [folder.name || 'Untitled folder']
    onDelete = () => props.onDeleteFolder(folder.id)
    canDelete = folders.length > 1
    body = <FolderPage folder={folder} campaigns={campaigns} onUpdate={(patch) => props.onUpdateFolder(folder.id, patch)} />
  } else if (campaign) {
    crumbs = [
      <button key="f" className="hover:text-foreground" onClick={() => campaignFolder && props.onPage({ kind: 'folder', id: campaignFolder.id })}>
        {campaignFolder?.name || 'Untitled folder'}
      </button>,
      campaign.name || 'Untitled campaign',
    ]
    onDelete = () => props.onDeleteCampaign(campaign.id)
    canDelete = campaigns.length > 1
    body = (
      <CampaignPage
        key={campaign.id}
        campaign={campaign}
        folders={folders}
        voices={voices}
        onUpdate={(patch) => props.onUpdateCampaign(campaign.id, patch)}
        onAttach={() => props.onAttach(campaign.id)}
        onRemoveAttachment={(a) => props.onRemoveAttachment(campaign.id, a)}
      />
    )
  } else if (voice) {
    crumbs = ['Voices', voice.name || 'Untitled voice']
    onDelete = () => props.onDeleteVoice(voice.id)
    canDelete = voices.length > 1
    body = (
      <VoicePage
        key={voice.id}
        voice={voice}
        onUpdate={(patch) => props.onUpdateVoice(voice.id, patch)}
        onAddNote={(n) => props.onAddVoiceNote(voice.id, n)}
        onDeleteNote={(n) => props.onDeleteVoiceNote(voice.id, n)}
        onAddExample={(e) => props.onAddExample(voice.id, e)}
        onDeleteExample={(e) => props.onDeleteExample(voice.id, e)}
      />
    )
  } else if (id) {
    crumbs = ['Not found']
    body = <Intro>This was deleted. It’s in Deleted items if you want it back.</Intro>
  } else {
    crumbs = [GENERAL_PAGES.find((p) => p.kind === page.kind)?.title]
    body = {
      mailbox: <MailboxPage settings={props.settings} onSaved={props.onSettings} />,
      email: <EmailStylePage style={props.emailStyle} onChange={props.onEmailStyle} />,
      snippets: (
        <SnippetsPage
          snippets={props.snippets}
          folders={folders}
          campaigns={campaigns}
          onAdd={props.onAddSnippet}
          onUpdate={props.onUpdateSnippet}
          onDelete={props.onDeleteSnippet}
        />
      ),
      claude: <ClaudePage settings={props.settings} onSaved={props.onSettings} />,
      appearance: <AppearancePage theme={props.theme} onTheme={props.onTheme} />,
      shortcuts: <ShortcutsPage />,
      trash: <TrashView items={props.trash} onRestore={props.onRestore} onPurge={props.onPurge} onEmpty={props.onEmptyTrash} />,
      data: <DataPage onReset={props.onReset} />,
    }[page.kind as 'mailbox']
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <TopBar>
        <nav className="flex min-w-0 flex-1 items-center gap-1.5" aria-label="Breadcrumb">
          <span className="text-muted-foreground">Settings</span>
          {crumbs.map((c, i) => (
            <span key={i} className="flex min-w-0 items-center gap-1.5">
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              <span className={i === crumbs.length - 1 ? 'truncate font-medium' : 'truncate text-muted-foreground'}>{c}</span>
            </span>
          ))}
        </nav>
        {onDelete && (
          <Button variant="ghost" size="sm" className="text-destructive" disabled={!canDelete} onClick={onDelete}>
            <Trash2 /> Delete
          </Button>
        )}
      </TopBar>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[760px] space-y-6 px-8 py-8 @max-xl:px-4">{body}</div>
      </div>
    </div>
  )
}
