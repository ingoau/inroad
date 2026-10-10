import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Check, MessageCircleQuestion } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AgentQuestion, AgentQuestionRequest } from '../../../shared/api'
import { useAgentName } from '../agent'
import { notifyDesktop } from '../desktopNotify'

// The opencode agent can pause a run to ask the user something (its question
// tool). The main process broadcasts those here and waits for the answer, so
// they show as a dialog over whatever the user is doing. Questions queue up:
// the first pending one is shown, and answering or skipping moves to the next.

export function AgentQuestions() {
  const agent = useAgentName()
  const [queue, setQueue] = useState<AgentQuestionRequest[]>([])

  useEffect(() => {
    const add = (req: AgentQuestionRequest) => setQueue((q) => (q.some((x) => x.requestId === req.requestId) ? q : [...q, req]))
    const unsubscribe = window.api?.agent.onQuestion(add)
    // A reloaded window may have missed questions that are still waiting.
    window.api?.agent.pendingQuestions().then((reqs) => reqs?.forEach(add)).catch(() => {})
    return unsubscribe
  }, [])

  const current = queue[0]
  useEffect(() => {
    if (current) notifyDesktop(`${agent} has a question`, current.questions[0]?.question ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.requestId])

  const done = (answers: string[][]) => {
    if (!current) return
    window.api?.agent.answer(current.requestId, answers)
    setQueue((q) => q.slice(1))
  }

  return (
    <Dialog open={!!current}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        {current && <QuestionForm key={current.requestId} request={current} agent={agent} onDone={done} />}
      </DialogContent>
    </Dialog>
  )
}

type AnswerState = { selected: string[]; custom: string }

function QuestionForm({ request, agent, onDone }: { request: AgentQuestionRequest; agent: string; onDone: (answers: string[][]) => void }) {
  const [state, setState] = useState<AnswerState[]>(() => request.questions.map(() => ({ selected: [], custom: '' })))

  const toggle = (i: number, q: AgentQuestion, label: string) =>
    setState((all) =>
      all.map((s, j) => {
        if (j !== i) return s
        if (q.multiple) return { ...s, selected: s.selected.includes(label) ? s.selected.filter((l) => l !== label) : [...s.selected, label] }
        return { ...s, selected: s.selected.includes(label) ? [] : [label] }
      }),
    )

  const setCustom = (i: number, custom: string) => setState((all) => all.map((s, j) => (j === i ? { ...s, custom } : s)))

  const answerFor = (i: number): string[] => {
    const custom = state[i].custom.trim()
    return custom ? [custom] : state[i].selected
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <MessageCircleQuestion className="size-4 text-muted-foreground" />
          {request.questions.length === 1 ? `A question from ${agent}` : `${agent} has a few questions`}
        </DialogTitle>
        <DialogDescription>{request.context || `Your answer helps ${agent} continue.`}</DialogDescription>
      </DialogHeader>

      <div className="grid max-h-[60vh] gap-4 overflow-y-auto">
        {request.questions.map((q, i) => (
          <div key={i} className="grid gap-1.5">
            {q.header && <div className="text-xs font-medium text-muted-foreground">{q.header}</div>}
            <div className="text-sm">{q.question}</div>
            {q.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {q.options.map((o) => {
                  const active = state[i].selected.includes(o.label)
                  return (
                    <Button key={o.label} size="xs" variant={active ? 'secondary' : 'outline'} title={o.description} onClick={() => toggle(i, q, o.label)}>
                      {active && <Check />} {o.label}
                    </Button>
                  )
                })}
              </div>
            )}
            {q.custom !== false && (
              <Input
                autoFocus={i === 0}
                value={state[i].custom}
                onChange={(e) => setCustom(i, e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onDone(request.questions.map((_, j) => answerFor(j)))}
                placeholder={q.options.length ? 'Or type your own answer' : 'Your answer'}
                className="h-8 bg-background"
              />
            )}
          </div>
        ))}
      </div>

      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={() => onDone(request.questions.map(() => []))}>
          Skip
        </Button>
        <Button size="sm" onClick={() => onDone(request.questions.map((_, i) => answerFor(i)))}>
          <Check /> Answer
        </Button>
      </DialogFooter>
    </>
  )
}
