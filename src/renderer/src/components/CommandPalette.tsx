import { Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { ReactNode } from 'react'
import { Keys } from './hint'

export interface PaletteCommand {
  id: string
  label: string
  group: 'Organisations' | 'Actions' | 'Campaigns & voices'
  icon?: ReactNode
  hint?: string
  shortcut?: string
  run: () => void
}

const GROUPS: PaletteCommand['group'][] = ['Organisations', 'Actions', 'Campaigns & voices']

export function CommandPalette({ open, onOpenChange, commands }: { open: boolean; onOpenChange: (o: boolean) => void; commands: PaletteCommand[] }) {
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Search & commands" description="Jump to an organisation or run a command">
      <Command>
        <CommandInput placeholder="Jump to an organisation or run a command…" />
        <CommandList>
          <CommandEmpty>No matches.</CommandEmpty>
          {GROUPS.map((group) => {
            const items = commands.filter((c) => c.group === group)
            if (!items.length) return null
            return (
              <CommandGroup key={group} heading={group}>
                {items.map((c) => (
                  <CommandItem
                    key={c.id}
                    value={`${c.label} ${c.hint ?? ''}`}
                    onSelect={() => {
                      onOpenChange(false)
                      c.run()
                    }}
                  >
                    {c.icon}
                    <span className="truncate">{c.label}</span>
                    {c.hint && <span className="text-xs text-muted-foreground">{c.hint}</span>}
                    {c.shortcut && <CommandShortcut>{c.shortcut}</CommandShortcut>}
                  </CommandItem>
                ))}
              </CommandGroup>
            )
          })}
        </CommandList>
      </Command>
    </CommandDialog>
  )
}

// Work everywhere, including while typing in the email or chat.
export function globalShortcuts(): [string, string][] {
  return [
    ['⌘ K', 'Search & commands (with text selected in the email: add a link)'],
    ['⌘ O', 'Switch campaign or folder'],
    ['⌘ ↵', 'Save to drafts and go to the next one'],
    ['⌘ Z', 'Undo (typing or actions, newest first)'],
    ['⌘ ⇧ Z', 'Redo'],
    ['⌘ \\', 'Toggle sidebar'],
    ['⌘ ⇧ \\', 'Toggle brief & chat panel'],
    ['⌘ /', 'Jump between email and chat (with text selected in the email: ask about it)'],
    ['⌘ N', 'Add to campaign (in the chat: new chat)'],
    ['⌘ ⇧ B', 'Show / hide the brief'],
    ['⌘ ]', 'Next organisation'],
    ['⌘ [', 'Previous organisation'],
    ['⌘ ⇧ ↵', 'Accept next suggestion'],
    ['⌘ ⇧ ⌫', 'Reject next suggestion'],
    ['⌘ D', 'Compare with the AI draft'],
    ['⌘ ⇧ H', 'History'],
    ['⌘ ,', 'Settings (mailbox and AI agent)'],
    ['⌘ R', 'Regenerate, or write with AI'],
    ['⌘ B', 'Bold (also ⌘ I italic, ⌘ ⇧ S strikethrough)'],
    ['esc', 'Stop the AI’s reply, or leave the text box'],
  ]
}

// Only when no text box is focused (press Esc first).
export const NAV_SHORTCUTS: [string, string][] = [
  ['J', 'Next organisation'],
  ['K', 'Previous organisation'],
  ['N', 'Next one that needs review'],
  ['E', 'Edit the email'],
  ['/', 'Chat'],
  ['T', 'Add the top suggested recipient'],
  ['A', 'Accept next suggestion'],
  ['X', 'Reject next suggestion'],
  ['1 2 3 4', 'Filter: to review / to write / all / saved'],
  ['C', 'Add to campaign'],
  ['⌫', 'Delete organisation (goes to Deleted items)'],
  ['?', 'This list'],
]

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Most of the time you’re typing, so everything important also has a ⌘ shortcut.</DialogDescription>
        </DialogHeader>
        <ShortcutList title="Anywhere, even while typing" items={globalShortcuts()} />
        <ShortcutList title="When you’re not in a text box" items={NAV_SHORTCUTS} />
      </DialogContent>
    </Dialog>
  )
}

function ShortcutList({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div>
      <h3 className="mb-1 text-xs font-medium text-muted-foreground">{title}</h3>
      <div className="divide-y text-sm">
        {items.map(([k, label]) => (
          <div key={k} className="flex items-center justify-between gap-4 py-1.5">
            <span>{label}</span>
            <Keys keys={k} />
          </div>
        ))}
      </div>
    </div>
  )
}
