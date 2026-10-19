// Smoke test for src/main/claude.ts against the real Agent SDK. With no
// ANTHROPIC_API_KEY it uses this machine's Claude Code sign-in.
//   npx tsx scripts/test-claude.ts [test|research|brief|chat|stop|voice|rules|tools|parse|guided|comment|answers|event <name>]
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyEventAnswers,
  chat,
  configureClaude,
  draft,
  isReadOnlyTool,
  learnVoice,
  lookupEvent,
  parseOrganisations,
  researchAndDraft,
  testClaude,
  writingRules,
} from '../src/main/claude'

configureClaude({ workspace: mkdtempSync(join(tmpdir(), 'inroad-')), clientApp: 'inroad/test' })
// INROAD_TEST_KEY, deliberately not ANTHROPIC_API_KEY.
const cfg = { apiKey: process.env.INROAD_TEST_KEY, model: 'opus', utilityModel: 'haiku' }
const which = process.argv[2] ?? 'test'
const voice = { name: 'Jordan', notes: ['Short paragraphs, under ~170 words.', 'Signs off "Cheers," then first name.'], examples: [] }
const log = (p: { kind: string; text: string }) => (p.kind === 'step' ? console.log('  ·', p.text) : process.stdout.write(p.text))

if (which === 'test') {
  const r = await testClaude(cfg)
  console.log(r)
  assert.ok(r.ok)
}

if (which === 'research') {
  const t = Date.now()
  const r = await researchAndDraft(
    cfg,
    {
      jobId: 'j1',
      company: 'Cloudflare',
      website: 'cloudflare.com',
      campaignNotes:
        'Hack the Harbour 2026, a 48-hour student hackathon in Sydney, 14–16 Nov, ~400 hackers. Asking for sponsorship (Gold $5k with a prize track) or API credits + a workshop.',
      voice,
      senderName: 'Jordan Ellis',
    },
    log,
  )
  if (!r.ok) throw new Error(r.error)
  console.log(`\n✓ research + draft in ${Math.round((Date.now() - t) / 1000)}s`)
  console.log(
    '  brief sections:',
    r.value.brief.sections.map((s) => s.title),
  )
  console.log(
    '  recipients:',
    r.value.brief.recipients.map((x) => `${x.name} <${x.email || 'none'}> ${x.confidence}`),
  )
  console.log('  sources:', r.value.brief.sources.length, '| research notes chars:', r.value.research.length)
  assert.ok(r.value.draft, 'expected a draft')
  console.log('  to:', r.value.draft.to, '| subject:', r.value.draft.subject)
  console.log('\n' + r.value.draft.body)
}

if (which === 'brief') {
  const r = await researchAndDraft(
    cfg,
    { jobId: 'j2', company: 'Canva', website: 'canva.com', campaignNotes: 'Looking for sponsors for a student hackathon in Sydney.', voice, senderName: 'Jordan', draft: false },
    log,
  )
  if (!r.ok) throw new Error(r.error)
  console.log('\n✓ research only:', r.value.brief.summary)
  assert.equal(r.value.draft, undefined, 'research-only returns no draft')
}

if (which === 'stop') {
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 4000)
  const r = await chat(
    cfg,
    {
      jobId: 'c3',
      company: 'Lumen Labs',
      campaignNotes: 'Asking for sponsorship.',
      voice,
      subject: 'Hack the Harbour',
      body: 'Hi Priya,\n\nWould you be open to sponsoring our hackathon?\n\nCheers,\nJordan',
      history: [],
      message: 'Write me a long explanation of every way this email could be improved.',
    },
    log,
    abort,
  )
  if (!r.ok) throw new Error(r.error)
  console.log('\n✓ stopped:', r.value.stopped, '| text so far:', r.value.text.length, 'chars')
  assert.ok(r.value.stopped)
}

if (which === 'chat') {
  const body =
    "Hi Priya,\n\nI'm Jordan from Hack the Harbour, a 48-hour student hackathon in Sydney.\n\nWould you be open to sponsoring our event?\n\nCheers,\nJordan"
  const r = await chat(
    cfg,
    {
      jobId: 'c1',
      company: 'Lumen Labs',
      campaignNotes: 'Asking for sponsorship.',
      voice,
      subject: 'Sponsoring Hack the Harbour?',
      body,
      history: [],
      message: 'make the ask more casual and specific: Gold tier, $5k',
    },
    log,
  )
  if (!r.ok) throw new Error(r.error)
  console.log('\n✓ chat:', r.value.text)
  console.log('  proposals:', r.value.proposals)
  assert.ok(r.value.proposals.length > 0, 'expected at least one propose_edit call')
  for (const p of r.value.proposals) assert.ok(body.includes(p.old), 'proposal quotes text that exists')
}

if (which === 'voice') {
  const r = await learnVoice(cfg, {
    voiceName: 'Jordan',
    notes: voice.notes,
    draft:
      'Hi Priya,\n\nI hope this email finds you well! I am reaching out regarding an exciting opportunity.\n\nWould you be open to a quick call?\n\nKind regards,\nJordan',
    final: 'Hi Priya,\n\nQuick one from Hack the Harbour.\n\nKeen to jump on a 15-min call?\n\nCheers,\nJordan',
  })
  if (!r.ok) throw new Error(r.error)
  console.log('✓ voice:', r.value)
}

if (which === 'tools') {
  for (const t of ['slack_search_public', 'search_email', 'read_thread', 'list_folders', 'fetch', 'get-overview', 'find-tasks'])
    assert.ok(isReadOnlyTool(t), `${t} should be allowed`)
  for (const t of [
    'slack_send_message',
    'slack_send_message_draft',
    'draft_email',
    'delete_email',
    'update-tasks',
    'add-comments',
    'ha_call_service',
    'search_and_delete',
  ])
    assert.ok(!isReadOnlyTool(t), `${t} should be denied`)
  console.log('✓ connector tool filter allows reads and blocks writes')
}

if (which === 'rules') {
  const r = await writingRules(cfg, {
    emails: [
      "Hey Sam,\n\nQuick one — are you still keen to judge at HackCBR? We're locking in the panel this week.\n\nNo stress if not, just let me know by Friday.\n\nCheers,\nIngo",
      "Hi all,\n\nVenue's confirmed for the 14th. Doors 6pm, we'll have pizza.\n\nBring a laptop and a charger. That's it.\n\nCheers,\nIngo",
    ],
  })
  if (!r.ok) throw new Error(r.error)
  console.log('✓ writing rules:', r.value.notes)
  assert.ok(r.value.notes.length >= 3)
}

if (which === 'event') {
  const t = Date.now()
  const r = await lookupEvent(cfg, { jobId: 'e1', name: process.argv[3] ?? 'HackCBR' }, log)
  if (!r.ok) throw new Error(r.error)
  console.log(`\n✓ event lookup in ${Math.round((Date.now() - t) / 1000)}s`)
  console.log(r.value.details)
  console.log('\nquestions:', JSON.stringify(r.value.questions, null, 1))
}

if (which === 'parse') {
  const t = Date.now()
  const r = await parseOrganisations(
    cfg,
    'Canva and Atlassian, both formal. PCBWay — they sponsored Campfire so mention that and ask for ~40 badges. Also JLCPCB (jlcpcb.com) and maybe Seeed Studio, write to their education team',
  )
  if (!r.ok) throw new Error(r.error)
  console.log(`✓ parsed in ${Math.round((Date.now() - t) / 1000)}s`, r.value)
  assert.equal(r.value.length, 5)
}

if (which === 'guided') {
  const r = await draft(cfg, {
    company: 'PCBWay',
    campaignNotes: 'Haven Canberra, a free game jam for teens (13–18) in Canberra, 14–15 November, ~30 attendees. Asking for sponsorship.',
    research: 'PCBWay is a PCB manufacturer in Shenzhen with a sponsorship programme for maker and student events (pcbway.com/sponsor.html).',
    voice,
    senderName: 'Ingo',
    emailFormat: 'Under 100 words. End with a question. Include a link to https://haven.hackclub.com/canberra.',
    orgNote: 'Mention they sponsored Campfire Canberra; ask for about 40 PCB badges.',
  })
  if (!r.ok) throw new Error(r.error)
  const body = r.value.body
  console.log(body, '\n')
  const words = body.split(/\s+/).filter(Boolean).length
  console.log('comments:', r.value.comments)
  for (const c of r.value.comments) assert.ok(body.includes(c.quote), 'comment quotes text in the body')
  console.log({
    words,
    mentionsCampfire: /campfire/i.test(body),
    asksFor40: /40/.test(body),
    hasLink: body.includes('haven.hackclub.com/canberra'),
    endsWithQuestion: /\?\s*(\n.*){0,4}$/.test(body.trim()),
  })
}

if (which === 'comment') {
  const body =
    "Hi Priya,\n\nI'm Jordan from Hack the Harbour, a 48-hour student hackathon in Sydney with around 400 hackers.\n\nLumen's vision API launched in March and would be a great fit.\n\nKeen to chat?\n\nCheers,\nJordan"
  const r = await chat(
    cfg,
    {
      jobId: 'c2',
      company: 'Lumen Labs',
      campaignNotes: 'Asking for sponsorship.',
      voice,
      subject: 'Hack the Harbour',
      body,
      history: [],
      message: 'anything in here I should double check before sending?',
    },
    log,
  )
  if (!r.ok) throw new Error(r.error)
  console.log('\n✓ chat:', r.value.text)
  console.log('  comments:', r.value.comments)
  assert.ok(r.value.comments.length > 0, 'expected add_comment calls')
}

if (which === 'answers') {
  const details =
    "What it is: Haven Canberra, a free two-day game jam for teens.\nDates: Saturday 14 and Sunday 15 November 2026\nPlace: Canberra, ACT\nMy own note: we're keen on local studios."
  const r = await applyEventAnswers(cfg, {
    name: 'Haven Canberra',
    details,
    answers: [
      { question: 'What should emails say about the venue?', answer: "Just say 'Canberra' for now" },
      { question: 'What are the start and finish times each day?', answer: '10am to 6pm both days' },
    ],
  })
  if (!r.ok) throw new Error(r.error)
  console.log(r.value.details)
  assert.ok(r.value.details.includes("My own note: we're keen on local studios."), 'keeps the user’s own line')
  assert.ok(/10\s?am/i.test(r.value.details), 'adds the times')
}
