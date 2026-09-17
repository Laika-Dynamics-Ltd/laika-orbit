export {
  type Category,
  categorise,
  claudeProjectName,
  type DocKind,
  docKind,
  KINDS,
  PROJECT_MARKERS,
  projectOf,
  smartGroups,
} from './categorise.ts'
export {
  anyOf,
  buildOptions,
  CONFIG_PATH,
  compilePattern,
  DEFAULT_CONFIG,
  type IndexConfig,
  type IndexSource,
  loadIndexConfig,
  normaliseConfig,
  saveIndexConfig,
  sourceDir,
} from './config.ts'
export { EXTRACTABLE, extractText } from './extract.ts'
export { type BrainIndex, buildIndex, ROUTER_PATH, W } from './index-build.ts'
export { buildAsk, EVIDENCE_CAP, LOW_CONFIDENCE_MARGIN, MAX_HOPS, recall } from './recall.ts'
export { type ParsedRouter, type ParseIssue, parseRouter, serialiseRouter } from './router.ts'
export { score } from './score.ts'
export { findHop, type Slice, sliceOf } from './slice.ts'
export {
  BINARY,
  DEFAULT_IGNORE,
  type FsStoreOpts,
  IMAGE,
  LocalFsStore,
  NOISE,
  type ScanStats,
  SourcedStore,
} from './store.ts'
export { isStopWord, tokenise } from './tokenise.ts'
export * from './types.ts'
