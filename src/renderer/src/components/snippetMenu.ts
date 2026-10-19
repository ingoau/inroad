import { Extension, type Editor, type JSONContent, type Range } from '@tiptap/core'
import { Suggestion, type SuggestionOptions } from '@tiptap/suggestion'
import { parseMarkdown } from '../markdown'

// Typing "/" in the email (at the start of a line or after a space) opens a
// menu of snippets and formats; picking one replaces "/query" with the
// snippet's text, or applies the format. The menu is drawn by RichEditor
// through `render`.

export interface SnippetItem {
  id: string
  name: string
  // Markdown.
  text: string
  // Where it's from, e.g. "Sponsors campaign", or a format's markdown shortcut.
  scope: string
  // Formats (lists, quote) run a command instead of inserting text.
  run?: (editor: Editor) => void
}

export interface SnippetMenuOptions {
  items: (query: string) => SnippetItem[]
  render: SuggestionOptions<SnippetItem, SnippetItem>['render']
}

// A one-paragraph snippet goes inline at the cursor; longer ones as blocks.
export function insertMarkdown(editor: Editor, range: Range, markdown: string) {
  const blocks = (parseMarkdown(markdown) as JSONContent).content ?? []
  const content = blocks.length === 1 && blocks[0].type === 'paragraph' ? (blocks[0].content ?? []) : blocks
  editor.chain().focus().insertContentAt(range, content).run()
}

export const SnippetMenu = Extension.create<SnippetMenuOptions>({
  name: 'snippetMenu',
  addOptions: () => ({ items: () => [], render: undefined }),
  addProseMirrorPlugins() {
    return [
      Suggestion<SnippetItem, SnippetItem>({
        editor: this.editor,
        char: '/',
        items: ({ query }) => this.options.items(query),
        render: this.options.render,
        command: ({ editor, range, props }) => {
          if (!props.run) return insertMarkdown(editor, range, props.text)
          editor.chain().focus().deleteRange(range).run()
          props.run(editor)
        },
      }),
    ]
  },
})
