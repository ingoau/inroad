import { generateHTML, generateJSON, type AnyExtension, type JSONContent } from '@tiptap/core'
import Blockquote from '@tiptap/extension-blockquote'
import HardBreak from '@tiptap/extension-hard-break'
import { Markdown, MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'

// Email bodies are stored as markdown: it's what Claude reads and writes, what
// the editor loads and saves, and what diffs and history compare. HTML only
// exists when a draft is sent to the mailbox.
//
// The dialect, kept close to how people type emails:
//   blank line = new paragraph, single newline = line break (e.g. the sign-off),
//   **bold**, *italic*, ~~strikethrough~~, [text](url), "- " and "1. " lists, "> " quotes.

// Single newlines are line breaks, and are written back as a plain "\n"
// (not the standard two-trailing-spaces form, which is invisible and easy to mangle).
const markedOptions = { gfm: true, breaks: true }
const LineBreak = HardBreak.extend({ renderMarkdown: () => '\n' })

// The library escapes every "&" and "<" in text in case it reads as HTML. Only
// escape the ones that would: "&" starting an entity, "<" starting a tag. So
// "Q&A" stays "Q&A" rather than "Q&amp;A".
type Encoder = { encodeTextForMarkdown(text: string, node: { marks?: unknown[] }, parent?: { type?: string }): string }
const proto = MarkdownManager.prototype as unknown as Encoder & {
  escapeMarkdownSyntax(text: string): string
  codeTypes: Set<string>
}
proto.encodeTextForMarkdown = function (this: typeof proto, text, node, parent) {
  const marks = (node.marks ?? []) as (string | { type: string })[]
  const inCode = (parent?.type && this.codeTypes.has(parent.type)) || marks.some((m) => this.codeTypes.has(typeof m === 'string' ? m : m.type))
  if (inCode) return text
  return this.escapeMarkdownSyntax(text.replace(/&(?=#?\w+;)/g, '&amp;').replace(/<(?=[a-zA-Z/!?])/g, '&lt;'))
}

// The formatting an email can have. No headings, sizes, fonts or colours, and
// no underline (markdown has none, and in an email it looks like a link).
export function emailExtensions(link: Record<string, unknown> = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: false,
      code: false,
      codeBlock: false,
      horizontalRule: false,
      trailingNode: false,
      blockquote: false,
      underline: false,
      hardBreak: false,
      link: { openOnClick: false, ...link },
    }),
    // ⌘⇧B is the app-wide "brief" shortcut, so quotes are toolbar-only.
    Blockquote.extend({ addKeyboardShortcuts: () => ({}) }),
    LineBreak,
    Markdown.configure({ markedOptions }),
  ]
}

const extensions = emailExtensions()
const manager = new MarkdownManager({ extensions, markedOptions })

export const parseMarkdown = (md: string) => manager.parse(md)

// The text a reader sees, without markdown syntax: paragraphs separated by a
// blank line, line breaks as "\n". Used to find a comment's quote in the email
// even if Claude quoted it with slightly different markdown.
export function plainText(md: string): string {
  type Node = { type?: string; text?: string; content?: Node[] }
  const blocks: string[] = []
  const inline = (n: Node): string => (n.type === 'text' ? (n.text ?? '') : n.type === 'hardBreak' ? '\n' : (n.content ?? []).map(inline).join(''))
  const walk = (n: Node) => {
    if (n.type === 'paragraph') blocks.push(inline(n))
    else (n.content ?? []).forEach(walk)
  }
  walk(manager.parse(md) as Node)
  return blocks.join('\n\n')
}

// The form the editor would write. Claude's markdown goes through this before
// it's stored, so "edited" means the user changed something, not that the
// editor reformatted "* item" as "- item".
export const normalizeMarkdown = (md: string) => (md.trim() ? manager.serialize(manager.parse(md)) : '')

export const markdownToHtml = (md: string) => (md.trim() ? generateHTML(manager.parse(md), extensions) : '')

// How saved emails look. Applied as inline styles, which is what mail apps
// respect; the editor previews the same values (see emailStyleVars).
export interface EmailStyle {
  font: 'default' | 'sans' | 'serif'
  size: 'default' | 'small' | 'medium' | 'large'
  // Space between paragraphs, lists and quotes.
  spacing: 'none' | 'compact' | 'normal'
  lineHeight: 'normal' | 'relaxed'
}

export const defaultEmailStyle: EmailStyle = { font: 'default', size: 'default', spacing: 'normal', lineHeight: 'normal' }

// '' = leave it to the reader's mail app.
const FONTS = { default: '', sans: "-apple-system, 'Helvetica Neue', Helvetica, Arial, sans-serif", serif: "Georgia, 'Times New Roman', serif" }
const SIZES = { default: '', small: '13px', medium: '14px', large: '16px' }
const GAPS = { none: '0', compact: '0.5em', normal: '1em' }
const LEADINGS = { normal: '', relaxed: '1.5' }

// The HTML that goes to the mailbox.
export function emailHtml(md: string, style: EmailStyle = defaultEmailStyle): string {
  const html = markdownToHtml(md)
  if (!html) return ''
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  const root = doc.body.firstElementChild as HTMLElement
  const gap = GAPS[style.spacing]
  root.querySelectorAll<HTMLElement>('p, ul, ol, blockquote').forEach((el) => {
    // Paragraphs inside list items and quotes take the container's spacing.
    const nested = el.tagName === 'P' && !!el.parentElement?.closest('li, blockquote')
    el.style.margin = nested || !el.nextElementSibling ? '0' : `0 0 ${gap}`
  })
  root.querySelectorAll<HTMLElement>('ul, ol').forEach((el) => {
    el.style.paddingLeft = '1.4em'
    el.style.listStyleType = el.tagName === 'OL' ? 'decimal' : 'disc'
  })
  root.querySelectorAll<HTMLElement>('blockquote').forEach((el) => {
    el.style.paddingLeft = '1em'
    el.style.borderLeft = '3px solid #ccc'
    el.style.color = '#555'
  })
  // Plain links: no target/rel attributes in an email.
  root.querySelectorAll('a').forEach((a) => {
    a.removeAttribute('target')
    a.removeAttribute('rel')
  })
  if (FONTS[style.font]) root.style.fontFamily = FONTS[style.font]
  if (SIZES[style.size]) root.style.fontSize = SIZES[style.size]
  if (LEADINGS[style.lineHeight]) root.style.lineHeight = LEADINGS[style.lineHeight]
  return root.getAttribute('style') ? root.outerHTML : root.innerHTML
}

// CSS variables for previewing a style in the editor (.email-body in index.css).
export function emailStyleVars(style: EmailStyle): Record<string, string> {
  return {
    '--email-font': FONTS[style.font] || 'inherit',
    '--email-size': SIZES[style.size] || '15px',
    '--email-gap': GAPS[style.spacing],
    '--email-leading': LEADINGS[style.lineHeight] || '1.65',
  }
}

// For bodies saved before markdown, which were HTML.
export const htmlToMarkdown = (html: string) => (html.trim() ? manager.serialize(generateJSON(html, extensions)) : '')
export const looksLikeHtml = (s: string) => /^\s*<(p|ul|ol|blockquote|div|br)\b/i.test(s)

// The plain-text part of the email: formatting marks dropped, links as "text (url)".
export function markdownToText(md: string): string {
  const doc = new DOMParser().parseFromString(markdownToHtml(md), 'text/html')
  doc.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href') ?? ''
    if (href && a.textContent !== href && `mailto:${a.textContent}` !== href) a.append(` (${href})`)
  })
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'))
  const blocks: string[] = []
  doc.body.childNodes.forEach((n) => {
    if (n instanceof HTMLElement && (n.tagName === 'UL' || n.tagName === 'OL')) {
      const ordered = n.tagName === 'OL'
      blocks.push([...n.querySelectorAll(':scope > li')].map((li, i) => `${ordered ? `${i + 1}.` : '-'} ${li.textContent?.trim()}`).join('\n'))
    } else if (n instanceof HTMLElement && n.tagName === 'BLOCKQUOTE') {
      blocks.push(
        (n.textContent ?? '')
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n'),
      )
    } else {
      blocks.push(n.textContent ?? '')
    }
  })
  return blocks.join('\n\n')
}

// A document (or a slice of one, e.g. the selection) back to markdown.
export const serializeMarkdown = (json: JSONContent) => manager.serialize(json)
