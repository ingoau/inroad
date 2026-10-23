import type {
  Candidate,
  ChatRequest,
  ChatResult,
  ClaudeProgress,
  DraftRequest,
  DiscoverRequest,
  DraftResult,
  EventAnswersRequest,
  EventLookupRequest,
  EventLookupResult,
  ParsedOrganisation,
  ResearchRequest,
  ResearchResult,
  Result,
  VoiceLearnRequest,
  VoiceLearnResult,
  WritingRulesRequest,
} from '../shared/api'
import type { ChatFileData } from '../shared/chatFiles'
import * as claude from './claude'
import * as opencode from './opencode'
import type { AiConfig } from './settings'

// Thin dispatcher: the renderer talks to one API, and this picks the backend
// from Settings. Both backends expose the same function signatures. Long
// requests take an AbortController so the user can stop them.

type Emit = (p: ClaudeProgress) => void

export function test(cfg: AiConfig): Promise<Result<{ via: 'api-key' | 'claude-login' | 'opencode' }>> {
  return cfg.provider === 'opencode' ? opencode.testOpencode(cfg.opencode) : claude.testClaude(cfg.claude)
}

export function researchAndDraft(cfg: AiConfig, req: ResearchRequest, emit: Emit, abort?: AbortController): Promise<Result<ResearchResult>> {
  return cfg.provider === 'opencode' ? opencode.researchAndDraft(cfg.opencode, req, emit, abort) : claude.researchAndDraft(cfg.claude, req, emit, abort)
}

export function draft(cfg: AiConfig, req: DraftRequest): Promise<Result<DraftResult>> {
  return cfg.provider === 'opencode' ? opencode.draft(cfg.opencode, req) : claude.draft(cfg.claude, req)
}

export function chat(cfg: AiConfig, req: ChatRequest, files: ChatFileData[], emit: Emit, abort?: AbortController): Promise<Result<ChatResult>> {
  return cfg.provider === 'opencode' ? opencode.chat(cfg.opencode, req, files, emit, abort) : claude.chat(cfg.claude, req, files, emit, abort)
}

export function learnVoice(cfg: AiConfig, req: VoiceLearnRequest): Promise<Result<VoiceLearnResult>> {
  return cfg.provider === 'opencode' ? opencode.learnVoice(cfg.opencode, req) : claude.learnVoice(cfg.claude, req)
}

export function lookupEvent(cfg: AiConfig, req: EventLookupRequest, emit: Emit, abort?: AbortController): Promise<Result<EventLookupResult>> {
  return cfg.provider === 'opencode' ? opencode.lookupEvent(cfg.opencode, req, emit, abort) : claude.lookupEvent(cfg.claude, req, emit, abort)
}

export function applyEventAnswers(cfg: AiConfig, req: EventAnswersRequest): Promise<Result<{ details: string }>> {
  return cfg.provider === 'opencode' ? opencode.applyEventAnswers(cfg.opencode, req) : claude.applyEventAnswers(cfg.claude, req)
}

export function writingRules(cfg: AiConfig, req: WritingRulesRequest): Promise<Result<{ notes: string[] }>> {
  return cfg.provider === 'opencode' ? opencode.writingRules(cfg.opencode, req) : claude.writingRules(cfg.claude, req)
}

export function parseOrganisations(cfg: AiConfig, text: string): Promise<Result<ParsedOrganisation[]>> {
  return cfg.provider === 'opencode' ? opencode.parseOrganisations(cfg.opencode, text) : claude.parseOrganisations(cfg.claude, text)
}

export function discover(cfg: AiConfig, req: DiscoverRequest, emit: Emit, abort?: AbortController): Promise<Result<Candidate[]>> {
  return cfg.provider === 'opencode' ? opencode.discover(cfg.opencode, req, emit, abort) : claude.discover(cfg.claude, req, emit, abort)
}
