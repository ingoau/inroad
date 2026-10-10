import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Check, CircleAlert, Loader2, MessageCircleQuestion, Sparkles } from 'lucide-react'
import type { EventQuestion } from '../../../shared/api'
import { useEffect, useRef, useState } from 'react'
import { useAgentName } from '../agent'
import { notifyDesktop } from '../desktopNotify'

// The parts of a folder these fields edit.
export interface FolderInfo {
  name: string
  notes: string
}

// A folder's name and shared context, with a button that has Claude look it
// up (usually an event) in the user's connected tools (Slack, email…) and on the web.
export function FolderFields({ folder, onChange, autoFocus }: { folder: FolderInfo; onChange: (f: FolderInfo) => void; autoFocus?: boolean }) {
  const agent = useAgentName()
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState<string[]>([])
  const [error, setError] = useState('')
  // Claude's questions from the last lookup, with what the user picked or typed.
  const [questions, setQuestions] = useState<(EventQuestion & { answer: string })[]>([])
  const [applying, setApplying] = useState(false)
  const job = useRef('')
  // Latest values for when the lookup finishes (the user may keep typing).
  const latest = useRef(folder)
  latest.current = folder

  useEffect(
    () =>
      window.api?.claude.onProgress((p) => {
        if (p.jobId === job.current && p.kind === 'step') setSteps((s) => [...s, p.text])
      }),
    [],
  )

  const lookUp = async () => {
    if (!window.api || !folder.name.trim()) return
    const name = folder.name.trim()
    job.current = crypto.randomUUID()
    setBusy(true)
    setSteps([])
    setQuestions([])
    setError('')
    const res = await window.api.claude.lookupEvent({ jobId: job.current, name, hint: folder.notes.trim() || undefined })
    setBusy(false)
    if (!res.ok) return setError(res.error)
    setQuestions(res.value.questions.map((q) => ({ ...q, answer: '' })))
    if (res.value.questions.length)
      notifyDesktop(
        `Questions about ${name}`,
        `${agent} has ${res.value.questions.length === 1 ? 'one question' : `${res.value.questions.length} questions`} for you.`,
      )
    // Keep anything the user had written, above what Claude found.
    const mine = latest.current.notes.trim()
    onChange({ ...latest.current, notes: mine ? `${mine}\n\n${res.value.details}` : res.value.details })
  }

  const answered = questions.filter((q) => q.answer.trim())
  const setAnswer = (i: number, answer: string) => setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, answer } : q)))

  // Claude folds the answers into the details, leaving everything else as it is.
  const applyAnswers = async () => {
    if (!window.api || !answered.length) return
    setApplying(true)
    setError('')
    const res = await window.api.claude.applyEventAnswers({
      name: latest.current.name.trim(),
      details: latest.current.notes,
      answers: answered.map((q) => ({ question: q.question, answer: q.answer.trim() })),
    })
    setApplying(false)
    if (!res.ok) return setError(res.error)
    onChange({ ...latest.current, notes: res.value.details })
    setQuestions([])
  }

  return (
    <div className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="folder-name">Name</Label>
        <div className="flex gap-2">
          <Input
            id="folder-name"
            autoFocus={autoFocus}
            value={folder.name}
            onChange={(e) => onChange({ ...folder, name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && lookUp()}
            placeholder="e.g. Hack the Harbour 2026"
          />
          <Button variant="outline" onClick={lookUp} disabled={busy || !folder.name.trim() || !window.api}>
            {busy ? <Loader2 className="animate-spin" /> : <Sparkles />} Find details
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {agent === 'opencode'
            ? 'opencode searches the web. It only reads; it never sends or changes anything.'
            : 'Claude searches the web and anything connected to your Claude account, like Slack or email. It only reads; it never sends or changes anything.'}
        </p>
      </div>

      {(busy || error) && (
        <div className="rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground">
          {error ? (
            <p className="flex items-start gap-2 text-destructive">
              <CircleAlert className="mt-0.5 size-4 shrink-0" /> {error}
            </p>
          ) : (
            <ol className="space-y-1">
              {(steps.length ? steps : ['Starting…']).slice(-5).map((s, i, all) => (
                <li key={i} className={i === all.length - 1 ? 'flex items-center gap-2 text-foreground' : 'pl-6'}>
                  {i === all.length - 1 && <Loader2 className="size-4 animate-spin" />}
                  {s}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {questions.length > 0 && !busy && (
        <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium">
            <MessageCircleQuestion className="size-4 text-muted-foreground" /> Claude has {questions.length === 1 ? 'a question' : 'a few questions'}
          </div>
          {questions.map((q, i) => (
            <div key={i} className="grid gap-1.5">
              <div>{q.question}</div>
              {q.options.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {q.options.map((o) => (
                    <Button key={o} size="xs" variant={q.answer === o ? 'secondary' : 'outline'} onClick={() => setAnswer(i, q.answer === o ? '' : o)}>
                      {q.answer === o && <Check />} {o}
                    </Button>
                  ))}
                </div>
              )}
              <Input
                value={q.options.includes(q.answer) ? '' : q.answer}
                onChange={(e) => setAnswer(i, e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && applyAnswers()}
                placeholder={q.options.length ? 'Or type your own answer' : 'Your answer'}
                className="h-8 bg-background"
              />
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setQuestions([])}>
              Skip
            </Button>
            <Button size="sm" onClick={applyAnswers} disabled={applying || !answered.length}>
              {applying ? <Loader2 className="animate-spin" /> : <Check />} Update details
            </Button>
          </div>
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="folder-notes">Shared context</Label>
        <Textarea
          id="folder-notes"
          value={folder.notes}
          onChange={(e) => onChange({ ...folder, notes: e.target.value })}
          placeholder="What it is, when and where, who comes and how many, past numbers, links. Every campaign in this folder uses it."
          className="min-h-48 leading-relaxed"
        />
      </div>
    </div>
  )
}
