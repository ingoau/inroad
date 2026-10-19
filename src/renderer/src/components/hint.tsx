import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

// Keys are written space-separated, e.g. "⌘ ⇧ B", and shown as separate chips.
export function Keys({ keys, className }: { keys: string; className?: string }) {
  return (
    <KbdGroup className={className}>
      {keys.split(' ').map((k) => (
        <Kbd key={k}>{k}</Kbd>
      ))}
    </KbdGroup>
  )
}

// Tooltip with a label and (optionally) the keyboard shortcut for it.
export function Hint({ label, keys, side, children }: { label: string; keys?: string; side?: 'top' | 'bottom' | 'left' | 'right'; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} className="flex items-center gap-2">
        {label}
        {keys && <Keys keys={keys} />}
      </TooltipContent>
    </Tooltip>
  )
}

// A single compact chip inside a button; tinted to suit a primary button.
export function ButtonKeys({ keys, primary, className }: { keys: string; primary?: boolean; className?: string }) {
  return (
    <Kbd className={cn('ml-0.5 tracking-wider', primary ? 'bg-primary-foreground/15 text-primary-foreground' : 'bg-foreground/5', className)}>
      {keys.replaceAll(' ', '')}
    </Kbd>
  )
}

// A shortcut written quietly after a label, e.g. "Settings ⌘,".
export function Shortcut({ keys, className }: { keys: string; className?: string }) {
  return <span className={cn('ml-1.5 text-xs font-normal tracking-wide text-muted-foreground/60', className)}>{keys}</span>
}
