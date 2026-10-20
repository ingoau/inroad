import { createContext, useContext, type ReactNode } from 'react'
import type { AiProvider } from '../../shared/api'

// Copy refers to "the AI" whichever backend runs it; the provider is only
// needed where they really differ (e.g. only Claude can read connected apps).
const AgentContext = createContext<AiProvider>('claude')

export function AgentProvider({ provider, children }: { provider: AiProvider | undefined; children: ReactNode }) {
  return <AgentContext.Provider value={provider ?? 'claude'}>{children}</AgentContext.Provider>
}

export function useAiProvider(): AiProvider {
  return useContext(AgentContext)
}
