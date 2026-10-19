import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import { exitSuggestion } from '@tiptap/suggestion'
import {
  Bold,
  BookmarkPlus,
  Check,
  Copy,
  ExternalLink,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquareQuote,
  Pencil,
  RemoveFormatting,
  Slash,
  Strikethrough,
  TextQuote,
  Unlink,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { emailExtensions, parseMarkdown, plainText, serializeMarkdown } from '../markdown'
import { currentEditor, historyDepth, undoBridge } from '../undo'
import { CommentHighlights, commentsKey, type Highlight } from './commentHighlights'
import { Hint, Keys } from './hint'
import { SnippetMenu, type SnippetItem } from './snippetMenu'
import { SuggestionHighlights, suggestionsKey, type InlineSuggestion } from './suggestionHighlights'

interface Props {
  // Markdown (see markdown.ts).
  value: string
  onChange: (markdown: string) => void
  // Phrases Claude commented on, highlighted in the text.
  highlights?: Highlight[]
  activeHighlight?: string | null
  onHighlightClick?: (id: string) => void
  // The AI's pending suggestions, shown in the text as tracked changes.
  suggestions?: InlineSuggestion[]
  onSuggestion?: (id: string, accept: boolean) => void
  // Highlight text and ask the AI about it.
  onAsk?: (text: string) => void
  // Snippets this email can use, inserted by typing "/".
  snippets?: SnippetItem[]
  // Where a selection can be saved as a snippet: value and label, most specific last.
  snippetScopes?: { value: string; label: string }[]
  onSaveSnippet?: (name: string, markdown: string, scope: string) => void
}

// The "/" snippet menu while it's open.
interface SlashMenu {
  items: SnippetItem[]
  index: number
  rect: DOMRect | null
  command: (item: SnippetItem) => void
}

// Saving the selection as a snippet.
interface SnippetDraft {
  name: string
  markdown: string
  scope: string
}

// What the link popover is editing: the range it applies to, plus the text and
// URL fields. `null` means the popover is just showing an existing link.
interface LinkDraft {
  from: number
  to: number
  text: string
  url: string
  isNew: boolean
}

// Deliberately small formatting set: no headings, sizes, fonts or colours, so
// emails stay looking like emails.
export function RichEditor({
  value,
  onChange,
  highlights = [],
  activeHighlight = null,
  onHighlightClick,
  suggestions = [],
  onSuggestion,
  onAsk,
  snippets = [],
  snippetScopes = [],
  onSaveSnippet,
}: Props) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onHighlightClickRef = useRef(onHighlightClick)
  onHighlightClickRef.current = onHighlightClick
  const onSuggestionRef = useRef(onSuggestion)
  onSuggestionRef.current = onSuggestion
  const snippetsRef = useRef(snippets)
  snippetsRef.current = snippets
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null)
  const linkDraftRef = useRef(linkDraft)
  linkDraftRef.current = linkDraft
  const startLinkRef = useRef<() => void>(() => {})
  const [slash, setSlash] = useState<SlashMenu | null>(null)
  const slashRef = useRef(slash)
  slashRef.current = slash
  const slashKeyRef = useRef<(e: KeyboardEvent) => boolean>(() => false)
  const [snippetDraft, setSnippetDraft] = useState<SnippetDraft | null>(null)
  const snippetDraftRef = useRef(snippetDraft)
  snippetDraftRef.current = snippetDraft

  const editor = useEditor({
    extensions: [
      ...emailExtensions({ autolink: true, linkOnPaste: true, defaultProtocol: 'https' }),
      CommentHighlights,
      SuggestionHighlights.configure({ onResolve: (id, accept) => onSuggestionRef.current?.(id, accept) }),
      SnippetMenu.configure({
        items: (query) => {
          const q = query.toLowerCase()
          const all = snippetsRef.current
          return [...all.filter((s) => s.name.toLowerCase().includes(q)), ...all.filter((s) => !s.name.toLowerCase().includes(q) && s.text.toLowerCase().includes(q))].slice(0, 8)
        },
        render: () => {
          const show = (p: { items: SnippetItem[]; command: (item: SnippetItem) => void; clientRect?: (() => DOMRect | null) | null }) =>
            setSlash({ items: p.items, index: 0, rect: p.clientRect?.() ?? null, command: p.command })
          return { onStart: show, onUpdate: show, onExit: () => setSlash(null), onKeyDown: ({ event }) => slashKeyRef.current(event) }
        },
      }),
    ],
    content: value,
    contentType: 'markdown',
    editorProps: {
      attributes: { id: 'email-body', class: 'email-body min-h-72 pt-4 pb-2 outline-none' },
      handleKeyDown: (view, e) => {
        const mod = e.metaKey || e.ctrlKey
        // Shared timeline: the app takes ⌘Z when its last action is newer than
        // this editor's typing (see undo.ts).
        if (mod && e.key.toLowerCase() === 'z') {
          return e.shiftKey ? undoBridge.redo(historyDepth(view.state, 'undone')) : undoBridge.undo(currentEditor(), historyDepth(view.state))
        }
        // App-wide shortcuts: stop the editor acting on them (⌘↵ would insert a
        // line break) and let them bubble to the window handler.
        if (mod && (e.key === 'Enter' || (e.shiftKey && e.key === 'Backspace'))) return true
        // ⌘K links the selection (or edits the link you're in); with nothing
        // selected it falls through to the command palette.
        if (mod && e.key.toLowerCase() === 'k' && (!view.state.selection.empty || currentEditor()?.isActive('link'))) {
          e.preventDefault()
          startLinkRef.current()
          return true
        }
        return false
      },
      // ⌘-click opens a link, like most editors. A plain click on a
      // highlighted phrase also shows its comment.
      handleClick: (view, pos, e) => {
        const commented = (e.target as HTMLElement).closest?.('[data-comment]')?.getAttribute('data-comment')
        if (commented) onHighlightClickRef.current?.(commented)
        if (!(e.metaKey || e.ctrlKey)) return false
        const href = view.state.doc
          .resolve(pos)
          .marks()
          .find((m) => m.type.name === 'link')?.attrs.href
        if (href) window.open(href, '_blank', 'noopener')
        return !!href
      },
    },
    onUpdate: ({ editor }) => onChangeRef.current(editor.getMarkdown()),
  })

  // Hand the highlights to the plugin (not part of the document or its history).
  const highlightKey = JSON.stringify([highlights, activeHighlight])
  useEffect(() => {
    if (!editor) return
    editor.view.dispatch(
      editor.state.tr.setMeta(commentsKey, { highlights, active: activeHighlight }).setMeta('addToHistory', false).setMeta('preventUpdate', true),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, highlightKey])

  // Same for the AI's pending suggestions.
  const suggestionKey = JSON.stringify(suggestions)
  useEffect(() => {
    if (!editor) return
    editor.view.dispatch(editor.state.tr.setMeta(suggestionsKey, suggestions).setMeta('addToHistory', false).setMeta('preventUpdate', true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, suggestionKey])

  // Arrow keys, ↵ / Tab and Esc while the snippet menu is open.
  slashKeyRef.current = (e) => {
    const menu = slashRef.current
    if (!menu || !editor) return false
    const n = menu.items.length
    if (e.key === 'Escape') {
      e.stopPropagation()
      exitSuggestion(editor.view)
      setSlash(null)
      return true
    }
    if (!n) return false
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setSlash({ ...menu, index: (menu.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n })
      return true
    }
    if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
      menu.command(menu.items[menu.index])
      return true
    }
    return false
  }

  // Pick up changes made outside the editor: accepted suggestions, restored versions.
  useEffect(() => {
    if (editor && editor.getMarkdown() !== value) patchContent(editor, value)
  }, [editor, value])

  startLinkRef.current = () => {
    if (!editor) return
    const inLink = editor.isActive('link')
    if (inLink) editor.chain().focus().extendMarkRange('link').run()
    const { from, to, empty } = editor.state.selection
    setLinkDraft({
      from,
      to,
      text: editor.state.doc.textBetween(from, to, ' '),
      url: inLink ? (editor.getAttributes('link').href ?? '') : '',
      isNew: !inLink && empty,
    })
  }

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e && {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        strike: e.isActive('strike'),
        bulletList: e.isActive('bulletList'),
        orderedList: e.isActive('orderedList'),
        blockquote: e.isActive('blockquote'),
        link: e.isActive('link'),
        href: e.getAttributes('link').href as string | undefined,
      },
  })

  if (!editor || !state) return null

  const closeLink = () => {
    setLinkDraft(null)
    editor.commands.focus()
  }

  const selectedText = () => {
    const { from, to } = editor.state.selection
    return editor.state.doc.textBetween(from, to, '\n')
  }

  const startSnippet = () => {
    const markdown = serializeMarkdown({ type: 'doc', content: editor.state.selection.content().content.toJSON() }).trim()
    if (!markdown) return
    const name = selectedText().split(/\s+/).slice(0, 4).join(' ')
    setSnippetDraft({ name, markdown, scope: snippetScopes.at(-1)?.value ?? 'global' })
  }

  const saveSnippet = (draft: SnippetDraft) => {
    if (!draft.name.trim()) return
    onSaveSnippet?.(draft.name.trim(), draft.markdown, draft.scope)
    setSnippetDraft(null)
    editor.commands.focus()
  }

  // Toolbar: type "/" where the cursor is to open the snippet menu.
  const openSnippets = () => {
    const { from } = editor.state.selection
    const before = editor.state.doc.textBetween(Math.max(0, from - 1), from, '\n', '\n')
    editor
      .chain()
      .focus()
      .insertContent(!before || /\s/.test(before) ? '/' : ' /')
      .run()
  }

  const applyLink = (draft: LinkDraft) => {
    const href = normaliseUrl(draft.url)
    const text = draft.text.trim() || draft.url.trim()
    if (!href) {
      // Empty URL = remove the link.
      editor.chain().focus().setTextSelection({ from: draft.from, to: draft.to }).unsetLink().run()
    } else {
      editor
        .chain()
        .focus()
        .insertContentAt({ from: draft.from, to: draft.to }, { type: 'text', text, marks: [{ type: 'link', attrs: { href } }] })
        .run()
    }
    setLinkDraft(null)
  }

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-1 flex h-10 items-center gap-0.5 border-b bg-background">
        <ToolBtn label="Bold" keys="⌘ B" active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()}>
          <Bold />
        </ToolBtn>
        <ToolBtn label="Italic" keys="⌘ I" active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <Italic />
        </ToolBtn>
        <ToolBtn label="Strikethrough" keys="⌘ ⇧ S" active={state.strike} onClick={() => editor.chain().focus().toggleStrike().run()}>
          <Strikethrough />
        </ToolBtn>
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
        <ToolBtn label="Link (select text first)" keys="⌘ K" active={state.link} onClick={() => startLinkRef.current()}>
          <Link2 />
        </ToolBtn>
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
        <ToolBtn label="Bulleted list" keys="⌘ ⇧ 8" active={state.bulletList} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <List />
        </ToolBtn>
        <ToolBtn label="Numbered list" keys="⌘ ⇧ 7" active={state.orderedList} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          <ListOrdered />
        </ToolBtn>
        <ToolBtn label="Quote" active={state.blockquote} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
          <TextQuote />
        </ToolBtn>
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
        <ToolBtn label="Clear formatting" onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
          <RemoveFormatting />
        </ToolBtn>
        {onSaveSnippet && (
          <>
            <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
            <ToolBtn label="Insert a snippet" keys="/" onClick={openSnippets}>
              <Slash />
            </ToolBtn>
          </>
        )}
      </div>

      {/* With text selected: ask the AI about it, or keep it as a snippet. */}
      <BubbleMenu
        editor={editor}
        pluginKey="selectionMenu"
        shouldShow={({ editor: e, from, to }) =>
          !!snippetDraftRef.current ||
          (from !== to && document.activeElement?.id === 'email-body' && !e.isActive('link') && !linkDraftRef.current && !!(onAsk || onSaveSnippet))
        }
        options={{ placement: 'top-start', offset: 8 }}
        className="z-30"
      >
        {snippetDraft ? (
          <SnippetForm draft={snippetDraft} scopes={snippetScopes} onChange={setSnippetDraft} onSave={saveSnippet} onCancel={() => setSnippetDraft(null)} />
        ) : (
          <div className={cn(popover, 'flex items-center gap-0.5 p-1')}>
            {onAsk && (
              <Button variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={() => onAsk(selectedText())}>
                <MessageSquareQuote /> Ask AI <Keys keys="⌘ /" className="ml-1" />
              </Button>
            )}
            {onSaveSnippet && (
              <Button variant="ghost" size="sm" onMouseDown={(e) => e.preventDefault()} onClick={startSnippet}>
                <BookmarkPlus /> Save as snippet
              </Button>
            )}
          </div>
        )}
      </BubbleMenu>

      {slash && snippets.length > 0 && slash.rect && (
        <div
          className={cn(popover, 'fixed z-40 w-72 p-1')}
          style={{ top: slash.rect.bottom + 6, left: Math.min(slash.rect.left, window.innerWidth - 300) }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {slash.items.length ? (
            slash.items.map((s, i) => (
              <button
                key={s.id}
                className={cn('flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-sm', i === slash.index && 'bg-accent text-accent-foreground')}
                onMouseEnter={() => setSlash({ ...slash, index: i })}
                onClick={() => slash.command(s)}
              >
                <span className="flex w-full items-center gap-2">
                  <span className="truncate font-medium">{s.name}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">{s.scope}</span>
                </span>
                <span className="line-clamp-1 text-xs text-muted-foreground">{plainText(s.text)}</span>
              </button>
            ))
          ) : (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No matching snippets</p>
          )}
          <p className="flex items-center gap-1 border-t px-2 pt-1.5 pb-1 text-xs text-muted-foreground">
            <Keys keys="↑↓" /> choose <Keys keys="↵" className="ml-1" /> insert <Keys keys="esc" className="ml-1" /> close
          </p>
        </div>
      )}

      <BubbleMenu
        editor={editor}
        // Show while editing a link, or when the cursor is inside one.
        shouldShow={({ editor: e }) => !!linkDraftRef.current || (e.isActive('link') && e.isFocused)}
        options={{ placement: 'bottom-start', offset: 8 }}
        className="z-30"
      >
        {linkDraft ? (
          <LinkForm draft={linkDraft} onChange={setLinkDraft} onApply={applyLink} onCancel={closeLink} />
        ) : state.href ? (
          <LinkPreview
            href={state.href}
            onEdit={() => startLinkRef.current()}
            onRemove={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
          />
        ) : null}
      </BubbleMenu>

      <EditorContent editor={editor} />
    </div>
  )
}

// mailto: for emails, https:// for bare domains, leave anything with a scheme alone.
function normaliseUrl(raw: string): string {
  const url = raw.trim()
  if (!url) return ''
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url)) return `mailto:${url}`
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url
  return `https://${url}`
}

const popover = 'animate-in fade-in-0 zoom-in-95 rounded-lg border bg-popover text-popover-foreground shadow-md'

function LinkPreview({ href, onEdit, onRemove }: { href: string; onEdit: () => void; onRemove: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className={cn(popover, 'flex max-w-[360px] items-center gap-0.5 p-1')}>
      <Button variant="ghost" size="sm" asChild className="min-w-0 justify-start font-normal">
        <a href={href} target="_blank" rel="noopener" title="Open link (⌘-click in the text works too)">
          <ExternalLink />
          <span className="truncate">{href.replace(/^(https?:\/\/|mailto:)/, '')}</span>
        </a>
      </Button>
      <Separator orientation="vertical" className="mx-0.5 data-[orientation=vertical]:h-4" />
      <ToolBtn
        label="Copy link"
        onClick={() => {
          navigator.clipboard?.writeText(href).catch(() => {})
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
      >
        {copied ? <Check className="text-success" /> : <Copy />}
      </ToolBtn>
      <ToolBtn label="Edit link" keys="⌘ K" onClick={onEdit}>
        <Pencil />
      </ToolBtn>
      <ToolBtn label="Remove link" onClick={onRemove}>
        <Unlink />
      </ToolBtn>
    </div>
  )
}

function SnippetForm({
  draft,
  scopes,
  onChange,
  onSave,
  onCancel,
}: {
  draft: SnippetDraft
  scopes: { value: string; label: string }[]
  onChange: (d: SnippetDraft) => void
  onSave: (d: SnippetDraft) => void
  onCancel: () => void
}) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onSave(draft)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }
  return (
    <div className={cn(popover, 'w-[340px] space-y-3 p-3')} onKeyDown={onKeyDown}>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Snippet name</span>
        <Input autoFocus value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} placeholder="e.g. Sponsor tiers" />
      </label>
      <div className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Use it in</span>
        <div className="flex flex-wrap gap-1">
          {scopes.map((s) => (
            <Button key={s.value} size="xs" variant={draft.scope === s.value ? 'secondary' : 'ghost'} onClick={() => onChange({ ...draft, scope: s.value })}>
              {s.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Keys keys="↵" /> save <Keys keys="esc" className="ml-1" /> cancel
        </span>
        <Button size="sm" disabled={!draft.name.trim()} onClick={() => onSave(draft)}>
          Save snippet
        </Button>
      </div>
    </div>
  )
}

function LinkForm({
  draft,
  onChange,
  onApply,
  onCancel,
}: {
  draft: LinkDraft
  onChange: (d: LinkDraft) => void
  onApply: (d: LinkDraft) => void
  onCancel: () => void
}) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      onApply(draft)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onCancel()
    }
  }
  const preview = normaliseUrl(draft.url)
  return (
    <div className={cn(popover, 'w-[340px] space-y-3 p-3')} onKeyDown={onKeyDown}>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Link to</span>
        <Input autoFocus value={draft.url} onChange={(e) => onChange({ ...draft, url: e.target.value })} placeholder="harbourhackers.com or name@company.com" />
        {preview && preview !== draft.url.trim() && <span className="block truncate text-xs text-muted-foreground">→ {preview}</span>}
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium text-muted-foreground">Text</span>
        <Input value={draft.text} onChange={(e) => onChange({ ...draft, text: e.target.value })} placeholder={draft.isNew ? 'Defaults to the address' : ''} />
      </label>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Keys keys="↵" /> save <Keys keys="esc" className="ml-1" /> cancel
        </span>
        <Button size="sm" variant={draft.url.trim() ? 'default' : 'destructive'} onClick={() => onApply(draft)}>
          {draft.url.trim() ? 'Save link' : 'Remove link'}
        </Button>
      </div>
    </div>
  )
}

// Apply an outside change (accepted suggestion, restored version…) by replacing
// only the part of the document that differs. Replacing the whole doc would
// turn the editor's earlier undo steps into no-ops. Kept out of the editor's
// history because the app's undo stack owns these changes.
function patchContent(editor: Editor, markdown: string) {
  const next = editor.schema.nodeFromJSON(parseMarkdown(markdown))
  const cur = editor.state.doc
  const start = cur.content.findDiffStart(next.content)
  if (start == null) return
  let { a: endA, b: endB } = cur.content.findDiffEnd(next.content)!
  const overlap = start - Math.min(endA, endB)
  if (overlap > 0) {
    endA += overlap
    endB += overlap
  }
  editor.view.dispatch(editor.state.tr.replace(start, endA, next.slice(start, endB)).setMeta('addToHistory', false).setMeta('preventUpdate', true))
}

function ToolBtn({ label, keys, active, onClick, children }: { label: string; keys?: string; active?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Hint label={label} keys={keys}>
      <Button
        variant={active ? 'secondary' : 'ghost'}
        size="icon-sm"
        // Keep the text selection: don't let the button steal focus on mousedown.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={cn(!active && 'text-muted-foreground')}
      >
        {children}
      </Button>
    </Hint>
  )
}
