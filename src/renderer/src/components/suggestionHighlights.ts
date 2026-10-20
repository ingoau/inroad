import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { wordDiff } from '../diff'
import { locate } from './commentHighlights'

// Shows the AI's pending suggestions as tracked changes in the email: removed
// words struck through, new words inline, with accept/reject buttons at the
// end. Like the comment highlights, the editor feeds the list in with a
// transaction meta and positions are found fresh, so they follow edits.

export interface InlineSuggestion {
  id: string
  // Both as plain text (no markdown).
  old: string
  new: string
  reason: string
  // The one ⌘⇧↵ / ⌘⇧⌫ act on.
  next: boolean
}

export const suggestionsKey = new PluginKey<InlineSuggestion[]>('suggestions')

export interface SuggestionOptions {
  onResolve: (id: string, accept: boolean) => void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag)
  node.className = className
  if (text) node.textContent = text
  return node
}

export const SuggestionHighlights = Extension.create<SuggestionOptions>({
  name: 'suggestionHighlights',
  addOptions: () => ({ onResolve: () => {} }),
  addProseMirrorPlugins() {
    const { onResolve } = this.options
    const buttons = (s: InlineSuggestion) => () => {
      const box = el('span', 'suggestion-actions')
      box.contentEditable = 'false'
      for (const [accept, label, glyph] of [
        [true, 'Accept', '✓'],
        [false, 'Reject', '✕'],
      ] as const) {
        const b = el('button', accept ? 'suggestion-accept' : 'suggestion-reject', glyph)
        b.type = 'button'
        b.title = `${label}: ${s.reason}`
        // Keep the editor's selection; act on click.
        b.addEventListener('mousedown', (e) => e.preventDefault())
        b.addEventListener('click', (e) => {
          e.preventDefault()
          onResolve(s.id, accept)
        })
        box.append(b)
      }
      return box
    }
    return [
      new Plugin<InlineSuggestion[]>({
        key: suggestionsKey,
        state: {
          init: () => [],
          apply: (tr, value) => tr.getMeta(suggestionsKey) ?? value,
        },
        props: {
          decorations(state) {
            const decorations: Decoration[] = []
            for (const s of suggestionsKey.getState(state)!) {
              const at = s.old && locate(state.doc, s.old)
              if (!at) continue
              const cls = s.next ? ' suggestion-next' : ''
              // Walk the word diff along the old text: deletions get struck
              // through where they are, insertions are shown before the next old character.
              let off = 0
              wordDiff(s.old, s.new).forEach((part, i) => {
                if (part.type === 'same') off += part.text.length
                else if (part.type === 'del') {
                  decorations.push(
                    Decoration.inline(at[off], at[off + part.text.length - 1] + 1, { class: `suggestion-del${cls}`, title: s.reason }),
                  )
                  off += part.text.length
                } else {
                  const pos = off < at.length ? at[off] : at[at.length - 1] + 1
                  decorations.push(
                    Decoration.widget(pos, () => el('ins', `suggestion-add${cls}`, part.text), { key: `${s.id}:${i}:${part.text}`, side: -1, ignoreSelection: true }),
                  )
                }
              })
              decorations.push(
                Decoration.widget(at[at.length - 1] + 1, buttons(s), { key: `${s.id}:actions`, side: 1, ignoreSelection: true, stopEvent: () => true }),
              )
            }
            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})
