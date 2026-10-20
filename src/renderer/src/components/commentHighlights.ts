import { Extension } from '@tiptap/core'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

// Highlights the phrases Claude commented on. The editor feeds in the list
// with a transaction meta (see RichEditor); positions are found fresh on each
// render, so highlights follow the text as it's edited.

export interface Highlight {
  id: string
  // The phrase as plain text (no markdown).
  text: string
  kind: 'verify' | 'note'
  // Shown on hover.
  title: string
}

interface State {
  highlights: Highlight[]
  active: string | null
}

export const commentsKey = new PluginKey<State>('comments')

// Where `text` appears in the document, within a single paragraph.
function find(doc: PMNode, text: string): [number, number] | null {
  const at = locate(doc, text)
  return at && [at[0], at[at.length - 1] + 1]
}

// The document position of each character of `text`, where it appears within
// a single paragraph (a line break counts as "\n").
export function locate(doc: PMNode, text: string): number[] | null {
  let hit: number[] | null = null
  doc.descendants((node, pos) => {
    if (hit) return false
    if (!node.isTextblock) return true
    // The paragraph's text, with each character's position in the document.
    let s = ''
    const at: number[] = []
    node.forEach((child, offset) => {
      const start = pos + 1 + offset
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) {
          s += child.text![i]
          at.push(start + i)
        }
      } else if (child.type.name === 'hardBreak') {
        s += '\n'
        at.push(start)
      }
    })
    const i = s.indexOf(text)
    if (i >= 0) hit = at.slice(i, i + text.length)
    return false
  })
  return hit
}

export const CommentHighlights = Extension.create({
  name: 'commentHighlights',
  addProseMirrorPlugins() {
    return [
      new Plugin<State>({
        key: commentsKey,
        state: {
          init: () => ({ highlights: [], active: null }),
          apply: (tr, value) => tr.getMeta(commentsKey) ?? value,
        },
        props: {
          decorations(state) {
            const { highlights, active } = commentsKey.getState(state)!
            const decorations: Decoration[] = []
            for (const h of highlights) {
              const range = h.text && find(state.doc, h.text)
              if (!range) continue
              decorations.push(
                Decoration.inline(range[0], range[1], {
                  class: `comment-mark comment-${h.kind}${h.id === active ? ' comment-active' : ''}`,
                  'data-comment': h.id,
                  title: h.title,
                }),
              )
            }
            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})
