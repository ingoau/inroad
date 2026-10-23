import { randomUUID } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import MailComposer from 'nodemailer/lib/mail-composer'
import type { DraftInput, DraftRef, MailSettings, Result, SentCheck, SentState } from '../shared/api'

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
    return { mailbox, messageId, savedAt: Date.now() }
  })
}

// The \Sent special-use folder, or one named like it. Undefined if there isn't one.
const findSent = (boxes: { path: string; name: string; specialUse?: string }[]) =>
  (boxes.find((b) => b.specialUse === '\\Sent') ?? boxes.find((b) => /^sent( items| mail| messages)?$/i.test(b.name)))?.path

// Mail apps and servers stamp the sent copy a little after the save; allow for clocks that disagree.
const CLOCK_SLACK_MS = 5 * 60_000
const DAY_MS = 86_400_000

// imapflow's search returns false when the server refuses it rather than
// throwing. That's "couldn't tell", not "not there".
type Found = number[] | false | undefined

// Drafts that are still there are the common case, so look there first. For
// the rest, the sent copy usually keeps our Message-ID; some mail apps (Apple
// Mail) write a new one, so fall back to a message sent to exactly the same
// address after the draft was saved. Not the subject: people tweak it before
// sending. Anything it can't be sure of is left out rather than called missing.
export function checkSent(creds: MailCreds, checks: SentCheck[]): Promise<Result<Record<string, SentState>>> {
  return run(creds, async (client) => {
    const out: Record<string, SentState> = {}
    // Not in Drafts (or Drafts is gone), so look in Sent.
    const rest: SentCheck[] = []
    const boxes = await client.list()
    for (const mailbox of new Set(checks.map((c) => c.ref.mailbox))) {
      const group = checks.filter((c) => c.ref.mailbox === mailbox)
      // A Drafts folder that was renamed or removed can't hold the draft.
      if (!boxes.some((b) => b.path === mailbox)) {
        rest.push(...group)
        continue
      }
      const lock = await client.getMailboxLock(mailbox).catch(() => null)
      if (!lock) continue // Busy or refused: try again next time.
      try {
        for (const c of group) {
          // Some mail apps only flag the sent draft \Deleted and leave it there.
          const found: Found = await client.search({ header: { 'message-id': c.ref.messageId }, deleted: false }, { uid: true })
          if (!found) continue
          if (found.length) out[c.id] = { state: 'draft' }
          else rest.push(c)
        }
      } finally {
        lock.release()
      }
    }
    if (!rest.length) return out
    const sent = findSent(boxes)
    // Without a Sent folder there's no telling sent from deleted, so say nothing.
    if (!sent) return out
    try {
      const lock = await client.getMailboxLock(sent)
      try {
        // Each sent message accounts for one draft at most.
        const claimed = new Set<number>()
        const details = async (uids: number[]) => {
          const msgs: { uid: number; at: number; to: string[] }[] = []
          for await (const m of client.fetch(uids.join(','), { internalDate: true, envelope: true }, { uid: true }))
            msgs.push({
              uid: m.uid,
              at: m.internalDate ? new Date(m.internalDate).getTime() : NaN,
              to: (m.envelope?.to ?? []).map((a) => a.address?.toLowerCase() ?? ''),
            })
          return msgs
        }
        // Message-IDs first, for every draft, so a guess by recipient can't take
        // a message another draft owns outright.
        const unmatched: SentCheck[] = []
        for (const c of rest) {
          const byId: Found = await client.search({ header: { 'message-id': c.ref.messageId } }, { uid: true })
          if (!byId) continue
          if (!byId.length) {
            unmatched.push(c)
            continue
          }
          // Our own Message-ID is certain, whatever the date says.
          const at = (await details(byId)).map((m) => m.at).filter((t) => !Number.isNaN(t))
          byId.forEach((u) => claimed.add(u))
          out[c.id] = { state: 'sent', at: at.length ? Math.min(...at) : Date.now() }
        }
        for (const c of unmatched) {
          const to = c.to?.[0]?.trim().toLowerCase()
          if (!to) {
            out[c.id] = { state: 'missing' }
            continue
          }
          const after = c.savedAt - CLOCK_SLACK_MS
          // SINCE compares dates only, in the server's timezone, so ask from a day
          // earlier and check the exact time here. TO matches substrings too
          // ("bojo@" for "jo@"), so check the address exactly.
          const byTo: Found = await client.search({ to, since: new Date(after - DAY_MS) }, { uid: true })
          if (!byTo) continue
          const match = (byTo.length ? await details(byTo) : [])
            .filter((m) => !claimed.has(m.uid) && m.at >= after && m.to.includes(to))
            .sort((x, y) => x.at - y.at)[0]
          if (match) {
            claimed.add(match.uid)
            out[c.id] = { state: 'sent', at: match.at }
          } else out[c.id] = { state: 'missing' }
        }
      } finally {
        lock.release()
      }
    } catch (err) {
      // Keep what Drafts told us; the rest waits for the next check.
      console.error('[mail] couldn’t check Sent:', (err as Error).message)
    }
    return out
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
