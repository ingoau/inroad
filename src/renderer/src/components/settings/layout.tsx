import { cn } from '@/lib/utils'
import type { ReactNode } from 'react'

// A titled group of settings rows in a bordered card.
export function SettingsSection({ title, description, children }: { title?: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      {title && <h2 className="text-xs text-muted-foreground">{title}</h2>}
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
      <div className="divide-y divide-border/60">{children}</div>
    </section>
  )
}

// One setting: what it is on the left, its control on the right. With
// `stacked`, the control goes underneath (for text areas and wide forms).
export function SettingsRow({
  title,
  description,
  children,
  stacked,
  htmlFor,
}: {
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  stacked?: boolean
  htmlFor?: string
}) {
  return (
    <div className={cn('flex gap-4 py-3.5', stacked ? 'flex-col' : 'items-center')}>
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="text-sm font-medium">
          {title}
        </label>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {children && <div className={cn(stacked ? 'w-full' : 'flex shrink-0 items-center gap-2')}>{children}</div>}
    </div>
  )
}

// Freeform content inside a section card (lists, previews).
export function SettingsBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('py-3.5', className)}>{children}</div>
}
