// What the chat accepts as attachments, shared by the renderer (to refuse a
// file straight away) and the main process (to check it again before storing).

export type ChatFileKind = 'image' | 'pdf' | 'text'

// The image formats Claude reads. The renderer re-encodes anything larger than
// the model uses anyway, so these rarely come near the API's 5 MB limit.
const IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|html?|ics|vcf|log)$/i

export const CHAT_FILE_MAX = 20 * 1024 * 1024
// Text files go into the prompt as-is, so keep them to a sensible length.
export const CHAT_TEXT_MAX = 200 * 1024

export function chatFileKind(mime: string, name: string): ChatFileKind | null {
  if (IMAGES.includes(mime)) return 'image'
  if (mime === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf'
  if (mime.startsWith('text/') || mime === 'application/json' || TEXT_EXT.test(name)) return 'text'
  return null
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
