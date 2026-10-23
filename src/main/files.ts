import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import type { Attachment, ChatFile, ChatFileUpload, Result } from '../shared/api'
import { CHAT_FILE_MAX, CHAT_TEXT_MAX, chatFileKind, type ChatFileData } from '../shared/chatFiles'

// Attachments are copied to userData/attachments/<id>/<name>. The renderer
// only ever passes back { id, name }, never a path, so it can't point the
// mail code at arbitrary files on disk.
const root = () => join(app.getPath('userData'), 'attachments')
const ID = /^[0-9a-f-]{36}$/

export async function pickAttachments(win: BrowserWindow | null): Promise<Attachment[]> {
  const opts: Electron.OpenDialogOptions = { title: 'Attach to every email', properties: ['openFile', 'multiSelections'] }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled) return []
  return Promise.all(
    res.filePaths.map(async (path) => {
      const id = randomUUID()
      const name = basename(path)
      await mkdir(join(root(), id), { recursive: true })
      await copyFile(path, join(root(), id, name))
      return { id, name, size: (await stat(path)).size }
    }),
  )
}

// Where a stored attachment lives, for the mail composer. Throws if it's gone.
export async function attachmentFile(a: Attachment): Promise<{ filename: string; path: string }> {
  if (!ID.test(a.id) || a.name !== basename(a.name) || a.name.startsWith('.')) throw new Error(`Invalid attachment “${a.name}”`)
  const path = join(root(), a.id, a.name)
  try {
    await stat(path)
  } catch {
    throw new Error(`The attachment “${a.name}” is missing. Remove it from the campaign and attach it again.`)
  }
  return { filename: a.name, path }
}

// ------------------------------------------------------------- chat files

// Files attached in the chat live in userData/chat-files/<id>/<name>, with the
// same rule as attachments: the renderer hands back an id and name, never a path.
const chatRoot = () => join(app.getPath('userData'), 'chat-files')

// "../../x.png" → "x.png"; pasted images often have no useful name at all.
const safeName = (name: string) => basename(name.replace(/\\/g, '/')).replace(/^\.+/, '').replace(/[\u0000-\u001f]/g, '').slice(0, 120) || 'file'

export async function saveChatFile(file: ChatFileUpload): Promise<Result<ChatFile>> {
  const name = safeName(file.name)
  if (!chatFileKind(file.mime, name)) return { ok: false, error: `The AI can’t read “${name}”. Attach an image, a PDF or a text file.` }
  const size = file.data.byteLength
  if (size > CHAT_FILE_MAX) return { ok: false, error: `“${name}” is too big to attach (the limit is ${CHAT_FILE_MAX / 1024 / 1024} MB).` }
  const id = randomUUID()
  await mkdir(join(chatRoot(), id), { recursive: true })
  await writeFile(join(chatRoot(), id, name), Buffer.from(file.data))
  return { ok: true, value: { id, name, size, mime: file.mime } }
}

// Reads a stored chat file back for the AI. Throws if it's invalid or gone.
export async function readChatFile(f: ChatFile): Promise<ChatFileData> {
  const kind = chatFileKind(f.mime, f.name)
  if (!ID.test(f.id) || f.name !== safeName(f.name) || !kind) throw new Error(`Invalid file “${f.name}”`)
  const path = join(chatRoot(), f.id, f.name)
  let buf: Buffer
  try {
    buf = await readFile(path)
  } catch {
    throw new Error(`The file “${f.name}” attached to this chat is missing. Start a new chat to carry on.`)
  }
  if (kind !== 'text') return { name: f.name, path, mime: kind === 'pdf' ? 'application/pdf' : f.mime, kind, data: buf.toString('base64') }
  const text = buf.toString('utf8')
  return { name: f.name, path, mime: f.mime, kind, data: text.slice(0, CHAT_TEXT_MAX), truncated: text.length > CHAT_TEXT_MAX }
}
