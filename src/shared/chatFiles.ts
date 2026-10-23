// What the chat accepts as attachments, shared by the renderer (to refuse a
// file straight away) and the main process (to check it again before storing).

export type ChatFileKind = 'image' | 'pdf' | 'text'

// The image formats Claude reads. The renderer re-encodes anything larger than
// the model uses anyway, so these rarely come near the API's 5 MB limit.
const IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|ics|vcf|log)$/i

// Every file in a chat is sent again with each message, so these stay well
// inside the API's 32 MB request limit (and opencode's 10 MiB per file).
export const CHAT_FILE_MAX = 10 * 1024 * 1024
export const CHAT_TOTAL_MAX = 24 * 1024 * 1024
// Text files go into the prompt as-is, so keep them to a sensible length.
export const CHAT_TEXT_MAX = 100 * 1024

export function chatFileKind(mime: string, name: string): ChatFileKind | null {
  if (IMAGES.includes(mime)) return 'image'
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf'
  if (mime.startsWith('text/') || mime === 'application/json' || TEXT_EXT.test(name)) return 'text'
  return null
}

// The real image format from the file's first bytes: a file's extension (and
// so its browser mime type) can lie, and Claude rejects a mismatched type.
export function sniffImage(bytes: Uint8Array): string | null {
  const at = (i: number, ...b: number[]) => b.every((x, j) => bytes[i + j] === x)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return null
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'application/pdf': 'pdf' }
// A name whose extension matches the format, since opencode types files by extension.
export function withExtension(name: string, mime: string) {
  const ext = EXT[mime]
  if (!ext || new RegExp(`\\.${ext === 'jpg' ? 'jpe?g' : ext}$`, 'i').test(name)) return name
  return `${name.replace(/\.(png|jpe?g|gif|webp|pdf)$/i, '')}.${ext}`
}

// For wrapping a text file in the prompt: no quotes or tags in the name, and
// no closing tag inside the text.
export function attachedText(f: { name: string; data: string; truncated?: boolean }) {
  const name = f.name.replace(/["<>]/g, '')
  const body = f.data.replace(/<\/attached_file>/gi, '</attached_file_>')
  return `<attached_file name="${name}">\n${body}${f.truncated ? '\n[…cut off here: the file is longer]' : ''}\n</attached_file>`
}

// A chat file read back from disk in the main process, ready for the AI.
export interface ChatFileData {
  name: string
  // On disk, for backends that attach files by path (opencode).
  path: string
  mime: string
  kind: ChatFileKind
  // Base64 for images and PDFs; the text itself (cut to CHAT_TEXT_MAX) for text files.
  data: string
  // The text file was longer than what's included.
  truncated?: boolean
}
