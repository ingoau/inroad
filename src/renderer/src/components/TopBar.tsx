import { SidebarTrigger } from '@/components/ui/sidebar'
import type { ReactNode } from 'react'
import { Hint } from './hint'

// The bar along the top of every main view. The sidebar toggle is always
// first, in the same place, whether the sidebar is open or not.
export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="drag flex h-12 shrink-0 items-center gap-5 px-4 text-sm">
      <Hint label="Toggle sidebar" keys="⌘ \">
        <SidebarTrigger className="-ml-1 text-muted-foreground hover:text-foreground" />
      </Hint>
      {children}
    </header>
  )
}
