/** Pointer types a router file can declare. These ARE the scoreable catalogue. */
export const POINTER_TYPES = ['Skills', 'Files', 'Reference', 'Thinking', 'Rules'] as const
export type PointerType = (typeof POINTER_TYPES)[number]

export interface Pointer {
  type: PointerType
  path: string
  description: string
  stage: string | null
  line: number
  source: string
}

export interface DocMeta {
  id: number
  path: string
  bytes: number
  mtimeMs: number
}

export interface Candidate {
  docId: number
  path: string
  score: number
  /** share of the winner's score this candidate sits at, 0..1 */
  relative: number
}

export interface RecallResult {
  question: string
  tokens: string[]
  candidates: Candidate[]
  /** (top - runnerUp) / top. Low margin = ambiguous, surfaced not hidden. */
  margin: number
  lowConfidence: boolean
  /** true when scoring found no candidate at all — distinct from an ambiguous tie */
  noMatch: boolean
  evidence: Evidence[]
  prompt: string
  stats: { scoredDocs: number; msScore: number; msTotal: number; bytesRead: number; hops: number }
}

export interface Evidence {
  path: string
  heading: string | null
  lines: string
  text: string
  viaHop: boolean
}

/** Storage seam. LocalFsStore now; a RemoteStore later changes nothing above it. */
export interface Store {
  listDocs(): AsyncIterable<DocMeta>
  readDoc(path: string): Promise<string>
  root(): string
}
