// Integration test for src/main/mail.ts against a local IMAP server:
//   docker run -d --rm --name inroad-greenmail -p 3143:3143 \
//     -e GREENMAIL_OPTS='-Dgreenmail.setup.test.imap -Dgreenmail.auth.disabled -Dgreenmail.hostname=0.0.0.0' \
//     greenmail/standalone
//   npx tsx scripts/test-mail.ts
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { checkSent, deleteDraft, saveDraft, testMail, type MailCreds } from '../src/main/mail'

const creds: MailCreds = {
  mail: { host: '127.0.0.1', port: 3143, secure: false, user: 'jordan@test.local', fromName: 'Jordan Ellis', fromEmail: 'jordan@test.local' },
  password: 'anything',
}

async function client() {
  const c = new ImapFlow({ host: '127.0.0.1', port: 3143, secure: false, auth: { user: creds.mail.user, pass: 'x' }, logger: false })
  await c.connect()
  return c
}

async function countDrafts() {
  const c = await client()
  try {
    return (await c.status('Drafts', { messages: true })).messages
  } finally {
    await c.logout()
  }
}

// GreenMail starts with only INBOX; a real provider already has Drafts.
const setup = await client()
const boxes = await setup.list()
if (!boxes.some((b) => b.name === 'Drafts')) await setup.mailboxCreate('Drafts')
if (!boxes.some((b) => b.name === 'Sent')) await setup.mailboxCreate('Sent')
await setup.logout()

const t = await testMail(creds)
assert.deepEqual(t, { ok: true, value: { draftsMailbox: 'Drafts' } })
console.log('✓ test connection finds Drafts')

const before = await countDrafts()
const prospectus = join(mkdtempSync(join(tmpdir(), 'inroad-')), 'Prospectus.pdf')
writeFileSync(prospectus, '%PDF-1.4 test')
const saved = await saveDraft(
  creds,
  { to: ['priya@lumenlabs.example'], subject: 'Hello', html: '<p>Hi <strong>Priya</strong></p>', text: 'Hi Priya,\n\nCheers,\nJordan', attachments: [] },
  [{ filename: 'Prospectus.pdf', path: prospectus }],
)
assert.ok(saved.ok, !saved.ok ? saved.error : '')
assert.equal(await countDrafts(), before! + 1)
console.log('✓ saveDraft appends to Drafts', saved.value)

// The saved message is flagged as a draft and has both HTML and text parts.
const c = await client()
const lock = await c.getMailboxLock('Drafts')
const uids = await c.search({ header: { 'message-id': saved.value.messageId } }, { uid: true })
assert.ok(uids && uids.length === 1)
const msg = await c.fetchOne(String(uids[0]), { flags: true, source: true, envelope: true }, { uid: true })
assert.ok(msg && msg.flags?.has('\\Draft'))
const src = msg.source!.toString()
assert.match(src, /text\/html/)
assert.match(src, /text\/plain/)
assert.match(src, /filename="?Prospectus\.pdf/)
// Fastmail and others refuse lines ending in a bare LF; GreenMail doesn't, so check here.
assert.doesNotMatch(src, /[^\r]\n/, 'message has bare LF line endings')
assert.equal(msg.envelope?.subject, 'Hello')
lock.release()
await c.logout()
console.log('✓ draft has \\Draft flag, HTML + text parts, subject and the attachment')

const del = await deleteDraft(creds, saved.value)
assert.deepEqual(del, { ok: true, value: null })
assert.equal(await countDrafts(), before)
console.log('✓ deleteDraft removes it again')

// Sent detection. Each case saves a fresh draft, then does what a mail app would.
const draft = (to: string) => ({ to: [to], subject: 'Sponsoring', html: '<p>Hi</p>', text: 'Hi', attachments: [] })
async function moveToSent(messageId: string, newId?: string, at = new Date()) {
  const c = await client()
  const lock = await c.getMailboxLock('Drafts')
  const uids = (await c.search({ header: { 'message-id': messageId } }, { uid: true })) || []
  const src = (await c.fetchOne(String(uids[0]), { source: true }, { uid: true }))!.source!.toString()
  await c.messageDelete(uids.join(','), { uid: true })
  lock.release()
  await c.append('Sent', newId ? src.replace(messageId, newId) : src, ['\\Seen'], at)
  await c.logout()
}
const check = async (id: string, ref: { mailbox: string; messageId: string; savedAt?: number }, to: string) => {
  const r = await checkSent(creds, [{ id, ref, to: [to], savedAt: ref.savedAt! }])
  assert.ok(r.ok, !r.ok ? r.error : '')
  return r.value[id]
}

const still = await saveDraft(creds, draft('a@still.example'))
assert.ok(still.ok)
assert.deepEqual(await check('still', still.value, 'a@still.example'), { state: 'draft' })
console.log('✓ checkSent: a draft still in Drafts is a draft')

const same = await saveDraft(creds, draft('b@same.example'))
assert.ok(same.ok)
await moveToSent(same.value.messageId)
assert.equal((await check('same', same.value, 'b@same.example'))?.state, 'sent')
console.log('✓ checkSent: sent copy with our Message-ID is sent')

const fresh = await saveDraft(creds, draft('c@fresh.example'))
assert.ok(fresh.ok)
await moveToSent(fresh.value.messageId, '<new-id@mail.example>')
assert.equal((await check('fresh', fresh.value, 'c@fresh.example'))?.state, 'sent')
console.log('✓ checkSent: sent copy with a new Message-ID is matched by recipient and time')

const old = await saveDraft(creds, draft('d@old.example'))
assert.ok(old.ok)
// Something sent to them a day before this draft doesn't count.
await moveToSent(old.value.messageId, '<older@mail.example>', new Date(Date.now() - 86_400_000))
assert.deepEqual(await check('old', old.value, 'd@old.example'), { state: 'missing' })
console.log('✓ checkSent: an earlier email to the same address is not this one')

const gone = await saveDraft(creds, draft('e@gone.example'))
assert.ok(gone.ok)
await deleteDraft(creds, gone.value)
assert.deepEqual(await check('gone', gone.value, 'e@gone.example'), { state: 'missing' })
console.log('✓ checkSent: a deleted draft is missing, not sent')

// Thunderbird-style: the sent draft is only flagged \Deleted, not expunged.
const flagged = await saveDraft(creds, draft('f@flagged.example'))
assert.ok(flagged.ok)
{
  const c = await client()
  const lock = await c.getMailboxLock('Drafts')
  const uids = (await c.search({ header: { 'message-id': flagged.value.messageId } }, { uid: true })) || []
  const src = (await c.fetchOne(String(uids[0]), { source: true }, { uid: true }))!.source!.toString()
  await c.messageFlagsAdd(uids.join(','), ['\\Deleted'], { uid: true })
  lock.release()
  await c.append('Sent', src, ['\\Seen'])
  await c.logout()
}
assert.equal((await check('flagged', flagged.value, 'f@flagged.example'))?.state, 'sent')
console.log('✓ checkSent: a draft flagged \\Deleted but not expunged counts as gone')

// TO search matches substrings; "bojo@" isn't "jo@".
const near = await saveDraft(creds, draft('jo@near.example'))
assert.ok(near.ok)
const other = await saveDraft(creds, draft('bojo@near.example'))
assert.ok(other.ok)
await deleteDraft(creds, near.value)
await moveToSent(other.value.messageId, '<bojo@mail.example>')
assert.deepEqual(await check('near', near.value, 'jo@near.example'), { state: 'missing' })
console.log('✓ checkSent: a similar address is not the same recipient')

// Two drafts to one person, one sent with a new Message-ID: only one is sent.
const one = await saveDraft(creds, draft('g@twice.example'))
const two = await saveDraft(creds, draft('g@twice.example'))
assert.ok(one.ok && two.ok)
await moveToSent(one.value.messageId, '<twice@mail.example>')
await deleteDraft(creds, two.value)
{
  const r = await checkSent(creds, [
    { id: 'one', ref: one.value, to: ['g@twice.example'], savedAt: one.value.savedAt! },
    { id: 'two', ref: two.value, to: ['g@twice.example'], savedAt: two.value.savedAt! },
  ])
  assert.ok(r.ok)
  assert.deepEqual(Object.values(r.value).map((s) => s.state).sort(), ['missing', 'sent'])
}
console.log('✓ checkSent: one sent email accounts for one draft')

const bad = await testMail({ ...creds, mail: { ...creds.mail, port: 1 } })
assert.equal(bad.ok, false)
console.log('✓ unreachable server gives a friendly error:', !bad.ok && bad.error)
