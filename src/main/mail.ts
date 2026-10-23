import { randomUUID } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import MailComposer from 'nodemailer/lib/mail-composer'
import type { DraftInput, DraftRef, MailSettings, Result } from '../shared/api'

export interface MailCreds {
  mail: MailSettings
  password: string
}

async function run<T>(creds: MailCreds, fn: (client: ImapFlow) => Promise<T>): Promise<Result<T>> {
  const client = new ImapFlow({
    host: creds.mail.host,
    port: creds.mail.port,
    secure: creds.mail.secure,
    auth: { user: creds.mail.user, pass: creds.password },
    logger: false,
    connectionTimeout: 15_000,
  })
  try {
    await client.connect()
    return { ok: true, value: await fn(client) }
  } catch (err) {
    return { ok: false, error: friendly(err) }
  } finally {
    await client.logout().catch(() => client.close())
  }
}

// imapflow's errors are terse; translate the common ones.
function friendly(err: unknown): string {
  const e = err as { message?: string; authenticationFailed?: boolean; code?: string; responseText?: string; executedCommand?: string }
  if (e.authenticationFailed) return 'The server rejected the username or password. Most providers need an app password.'
  if (e.code === 'ENOTFOUND') return 'Couldn’t find that mail server. Check the server name.'
  if (e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') return 'Couldn’t reach the mail server. Check the server and port.'
  // The server said no to a command: its own reason is far more useful than "Command failed".
  if (e.message === 'Command failed') {
    // "A12 APPEND "Drafts" ..." → "APPEND". Only the verb: the rest can include message details.
    const verb = e.executedCommand?.split(' ')[1]
    console.error('[mail] server refused', verb ?? 'a command', '—', e.responseText ?? '(no reason given)')
    return `The mail server refused${verb ? ` ${verb}` : ' the request'}: ${e.responseText || 'no reason given'}`
  }
  return e.message ?? String(err)
}

const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n')

// Use the server's \Drafts special-use folder; fall back to a folder named like Drafts.
async function findDrafts(client: ImapFlow): Promise<string> {
  const boxes = await client.list()
  const special = boxes.find((b) => b.specialUse === '\\Drafts')
  if (special) return special.path
  const named = boxes.find((b) => /^drafts?$/i.test(b.name))
  if (named) return named.path
  throw new Error('Couldn’t find a Drafts folder in this mailbox')
}

export const testMail = (creds: MailCreds) => run(creds, async (client) => ({ draftsMailbox: await findDrafts(client) }))

// files: the draft's attachments, already resolved to paths on disk.
export function saveDraft(creds: MailCreds, draft: DraftInput, files: { filename: string; path: string }[] = []): Promise<Result<DraftRef>> {
  return run(creds, async (client) => {
    const mailbox = await findDrafts(client)
    // Our own Message-ID lets us find the draft later, even on servers that
    // don't report the new message's UID.
    const messageId = `<${randomUUID()}@inroad.local>`
    const { mail } = creds
    const message = new MailComposer({
      from: mail.fromName ? { name: mail.fromName, address: mail.fromEmail } : mail.fromEmail,
      to: draft.to,
      bcc: mail.bcc?.trim() || undefined,
      subject: draft.subject,
      // Email lines end in CRLF; servers like Fastmail refuse a bare "\n", and
      // the composer leaves 7-bit text parts exactly as given.
      html: crlf(draft.html),
      text: crlf(draft.text),
      attachments: files,
      messageId,
    }).compile()
    // The composer drops Bcc by default (it's meant for sending); a draft
    // needs it kept so the mail app sends the copy.
    message.keepBcc = true
    const raw = await message.build()
    const res = await client.append(mailbox, raw, ['\\Draft', '\\Seen'])
    if (!res) throw new Error('The server refused the draft')
    return { mailbox, messageId }
  })
}

export function deleteDraft(creds: MailCreds, ref: DraftRef): Promise<Result<null>> {
  return run(creds, async (client) => {
    const lock = await client.getMailboxLock(ref.mailbox)
    try {
      const uids = await client.search({ header: { 'message-id': ref.messageId } }, { uid: true })
      if (uids && uids.length) await client.messageDelete(uids.join(','), { uid: true })
      return null
    } finally {
      lock.release()
    }
  })
}
