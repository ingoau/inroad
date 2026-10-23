import type { ChatFile, Result } from '../../shared/api'
import { CHAT_FILE_MAX, chatFileKind } from '../../shared/chatFiles'

// A file attached to a chat message, plus a small preview for images. The
// preview is a data URL kept with the chat, so it shows without asking the
// main process; the full file stays on disk.
export interface ChatAttachment extends ChatFile {
  thumb?: string
}

// The longest edge Claude uses before scaling an image down itself, so larger
// images only cost upload time.
const MAX_EDGE = 1568
const THUMB_EDGE = 240

// Draws an image at most `edge` pixels on its longest side.
function draw(img: ImageBitmap, edge: number) {
  const scale = Math.min(1, edge / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.width * scale))
  canvas.height = Math.max(1, Math.round(img.height * scale))
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  return { canvas, scaled: scale < 1 }
}

const blob = (canvas: HTMLCanvasElement, type: string) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Couldn’t read that image.'))), type, 0.88))

// Pasted screenshots arrive as "image.png"; give them a name worth reading.
function nameFor(file: File) {
  if (file.name && file.name !== 'image.png') return file.name
  const ext = file.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
  return `Pasted image ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).replace(/[:\s]/g, '.')}.${ext}`
}

// Reads a picked, pasted or dropped file, shrinks big images, and stores it.
export async function attachChatFile(file: File): Promise<Result<ChatAttachment>> {
  const name = nameFor(file)
  const kind = chatFileKind(file.type, name)
  if (!kind) return { ok: false, error: `The AI can’t read “${name}”. Attach an image, a PDF or a text file.` }
  if (!window.api) return { ok: false, error: 'Attaching files works in the Inroad desktop app.' }
  let data: Blob = file
  let mime = file.type
  let thumb: string | undefined
  if (kind === 'image') {
    let img: ImageBitmap
    try {
      img = await createImageBitmap(file)
    } catch {
      return { ok: false, error: `Couldn’t read the image “${name}”.` }
    }
    const full = draw(img, MAX_EDGE)
    // GIFs and small images go as they are; anything bigger is re-encoded
    // (PNG keeps transparency and sharp text in screenshots).
    if (full.scaled || file.size > 3.5 * 1024 * 1024) {
      mime = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'
      data = await blob(full.canvas, mime)
      if (data.size > 3.5 * 1024 * 1024) data = await blob(full.canvas, (mime = 'image/jpeg'))
    }
    thumb = draw(img, THUMB_EDGE).canvas.toDataURL('image/webp', 0.8)
    img.close()
  }
  if (data.size > CHAT_FILE_MAX) return { ok: false, error: `“${name}” is too big to attach (the limit is ${CHAT_FILE_MAX / 1024 / 1024} MB).` }
  // A re-encoded image gets the extension of its new format.
  const stored = mime === file.type ? name : `${name.replace(/\.\w+$/, '')}.${mime === 'image/png' ? 'png' : 'jpg'}`
  const saved = await window.api.files.saveChatFile({ name: stored, mime, data: await data.arrayBuffer() })
  return saved.ok ? { ok: true, value: { ...saved.value, thumb } } : saved
}

// The file picker's filter, matching chatFileKind.
export const CHAT_FILE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.xml,.html,.htm,.ics,.vcf,.log'
