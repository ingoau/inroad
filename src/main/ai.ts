import type {
  ChatRequest,
  ChatResult,
  ClaudeProgress,
  DraftRequest,
  DraftResult,
  EventAnswersRequest,
  EventLookupRequest,
  EventLookupResult,
  LeadSuggestionsRequest,
  ParsedOrganisation,
  ResearchRequest,
  ResearchResult,
  Result,
  VoiceLearnRequest,
  VoiceLearnResult,
  WritingRulesRequest,
} from '../shared/api'
import * as claude from './claude'
import * as opencode from './opencode'
import type { AiConfig } from './settings'

// Thin dispatcher: the renderer talks to one API, and this picks the backend
// from Settings. Both backends expose the same function signatures.

type Emit = (p: ClaudeProgress) => void

// MCP servers are global agent config; hand the current list to both backends
// before each run so whichever one is chosen picks up the latest settings.
function applyMcp(cfg: AiConfig) {
  claude.setMcpServers(cfg.mcpServers)
  opencode.setMcpServers(cfg.mcpServers)
}

export function test(cfg: AiConfig): Promise<Result<{ via: 'api-key' | 'claude-login' | 'opencode' }>> {
  applyMcp(cfg)
  return cfg.provider === 'opencode' ? opencode.testOpencode(cfg.opencode) : claude.testClaude(cfg.anthropicKey)
}

export function researchAndDraft(cfg: AiConfig, req: ResearchRequest, emit: Emit): Promise<Result<ResearchResult>> {
  applyMcp(cfg)
  return cfg.provider === 'opencode' ? opencode.researchAndDraft(cfg.opencode, req, emit) : claude.researchAndDraft(cfg.anthropicKey, req, emit)
}

export function draft(cfg: AiConfig, req: DraftRequest): Promise<Result<DraftResult>> {
  applyMcp(cfg)
  return cfg.provider === 'opencode' ? opencode.draft(cfg.opencode, req) : claude.draft(cfg.anthropicKey, req)
}

export function chat(cfg: AiConfig, req: ChatRequest, emit: Emit): Promise<Result<ChatResult>> {
  applyMcp(cfg)
  return cfg.provider === 'opencode' ? opencode.chat(cfg.opencode, req, emit) : claude.chat(cfg.anthropicKey, req, emit)
}

export function learnVoice(cfg: AiConfig, req: VoiceLearnRequest): Promise<Result<VoiceLearnResult>> {
  applyMcp(cfg)
  return cfg.provider === 'opencode' ? opencode.learnVoice(cfg.opencode, req) : claude.learnVoice(cfg.anthropicKey, req)
}

export function lookupEvent(cfg: AiConfig, req: EventLookupRequest, emit: Emit): Promise<Result<EventLookupResult>> {
  applyMcp(cfg)
  return cfg.provider === 'opencode' ? opencode.lookupEvent(cfg.opencode, req, emit) : claude.lookupEvent(cfg.anthropicKey, req, emit)
}

export function applyEventAnswers(cfg: AiConfig, req: EventAnswersRequest): Promise<Result<{ details: string }>> {
  applyMcp(cfg)
  return cfg.provider === 'opencode' ? opencode.applyEventAnswers(cfg.opencode, req) : claude.applyEventAnswers(cfg.anthropicKey, req)
}

export function writingRules(cfg: AiConfig, req: WritingRulesRequest): Promise<Result<{ notes: string[] }>> {
  applyMcp(cfg)
  return cfg.provider === 'opencode' ? opencode.writingRules(cfg.opencode, req) : claude.writingRules(cfg.anthropicKey, req)
}

export function parseOrganisations(cfg: AiConfig, text: string): Promise<Result<ParsedOrganisation[]>> {
  applyMcp(cfg)
  return cfg.provider === 'opencode' ? opencode.parseOrganisations(cfg.opencode, text) : claude.parseOrganisations(cfg.anthropicKey, text)
}

export function suggestLeads(cfg: AiConfig, req: LeadSuggestionsRequest, emit: Emit): Promise<Result<ParsedOrganisation[]>> {
  applyMcp(cfg)
  return cfg.provider === 'opencode' ? opencode.suggestLeads(cfg.opencode, req, emit) : claude.suggestLeads(cfg.anthropicKey, req, emit)
}
