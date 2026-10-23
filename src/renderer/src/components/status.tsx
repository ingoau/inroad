import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { AlertCircle, CircleCheck, CircleDot, Clock, FileSearch, Loader2, PenLine, Send, type LucideIcon } from 'lucide-react'
import type { Status } from '../data'

// Only "saved", "sent" and "failed" carry colour, because those are the ones that matter.
export const statusStyle: Record<Status, { label: string; Icon: LucideIcon; tone: string }> = {
  queued: { label: 'Queued', Icon: Clock, tone: 'text-muted-foreground' },
  researching: { label: 'Researching', Icon: Loader2, tone: 'text-muted-foreground' },
  researched: { label: 'Researched', Icon: FileSearch, tone: 'text-muted-foreground' },
  drafted: { label: 'To review', Icon: CircleDot, tone: 'text-muted-foreground' },
  edited: { label: 'Edited', Icon: PenLine, tone: 'text-muted-foreground' },
  saved: { label: 'In drafts', Icon: CircleCheck, tone: 'text-success' },
  sent: { label: 'Sent', Icon: Send, tone: 'text-success' },
  failed: { label: 'Needs input', Icon: AlertCircle, tone: 'text-destructive' },
}

export function StatusIcon({ status, className }: { status: Status; className?: string }) {
  const { Icon, tone } = statusStyle[status]
  return <Icon className={cn('size-3.5 shrink-0', tone, status === 'researching' && 'animate-spin', className)} />
}

export function StatusBadge({ status }: { status: Status }) {
  return (
    <Badge variant="secondary" className={cn('gap-1', statusStyle[status].tone)}>
      <StatusIcon status={status} className="size-3" />
      {statusStyle[status].label}
    </Badge>
  )
}
