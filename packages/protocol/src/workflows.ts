export type WorkflowRunState =
  | 'queued'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'recovery-required';
export type WorkflowFindingKind =
  | 'identity-conflict'
  | 'suspected-mismatch'
  | 'missing-front-artwork'
  | 'questionable-front-artwork'
  | 'unavailable-selected-artwork';
export interface WorkflowScope {
  libraryId?: string;
  rootId?: string;
  sourceIds?: string[];
  unassigned?: boolean;
}
export interface WorkflowOptions {
  online: boolean;
  checksum: boolean;
  shareImages: boolean;
  providerIds?: string[];
  reasonerConnectionId?: string;
  coverInspectorConnectionId?: string;
}
export interface WorkflowRunDraft {
  workflowId: string;
  workflowDigest: string;
  hostId: string;
  scope: WorkflowScope;
  options: WorkflowOptions;
}
export interface WorkflowRun extends WorkflowRunDraft {
  id: string;
  actorId: string;
  state: WorkflowRunState;
  revision: number;
  total: number;
  processed: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}
export interface WorkflowPackageSummary {
  id: string;
  name: string;
  version: string;
  digest: string;
  kind: 'workflow' | 'translator' | 'tool';
}
export interface WorkflowHost {
  id: string;
  ownerId: string;
  name: string;
  enrolled: boolean;
  packages?: WorkflowPackageSummary[];
  lastSeenAt?: string | null;
  revokedAt: string | null;
  createdAt: string;
}
export interface WorkflowLease {
  runId: string;
  hostId: string;
  fence: number;
  expiresAt: string;
}
export interface WorkflowSourceSnapshot {
  sourceId: string;
  indexValidator: string;
  selectionRevision: number;
  state: 'pending' | 'completed';
  outputJson?: string;
}
export interface WorkflowPublication {
  sequence: number;
  checkpointRef: string;
  completedSourceIds: string[];
  state?: 'running' | 'completed';
  sourceOutputs?: { sourceId: string; outputJson: string }[];
}
export interface WorkflowFindingDraft {
  sourceId: string;
  kind: WorkflowFindingKind;
  ruleVersion: string;
  currentValueDigest: string;
  evidenceDigest: string;
  reason: string;
  evidenceIds: string[];
}
export interface WorkflowFinding extends WorkflowFindingDraft {
  id: string;
  runId: string;
  fingerprint: string;
  dismissed: boolean;
}
export interface WorkflowEvidence {
  id: string;
  runId: string;
  sourceId: string;
  kind: 'source-fact' | 'catalog' | 'filename' | 'model-observation' | 'tool-observation';
  sourceValidator: string;
  providerId: string | null;
  payloadJson: string;
}
export interface CleanupChange {
  action: 'replace-metadata' | 'replace-system' | 'replace-front-artwork';
  candidateId: string;
  artifactId: string | null;
  snapshotJson: string;
}
export interface WorkflowProposal {
  sourceName?: string;
  evidenceClass?: WorkflowCatalogCandidate['evidenceClass'];
  id: string;
  version: number;
  runId: string;
  findingId: string;
  sourceId: string;
  sourceValidator: string;
  selectionRevision: number;
  currentValueDigest: string;
  change: CleanupChange;
  evidenceIds: string[];
  reason: string;
  digest: string;
}
export interface WorkflowArtifact {
  id: string;
  runId: string;
  sourceId: string;
  sha256: string;
  size: number;
  contentType: string;
  width: number;
  height: number;
  attributionJson: string;
  expiresAt: string | null;
}
export interface WorkflowApproval {
  id: string;
  runId: string;
  actorId: string;
  runRevision: number;
  proposalVersionsJson: string;
  digest: string;
  createdAt: string;
}
export interface WorkflowProposalVersion {
  id: string;
  version: number;
  digest: string;
}
export interface WorkflowApplication {
  id: string;
  approvalId: string;
  sourceId: string;
  status: 'applied' | 'conflict' | 'failed' | 'undone';
  beforeRevision: number;
  afterRevision: number;
  resultJson: string;
  undoExpiresAt: string;
}
export interface WorkflowPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface WorkflowSelectionSummary {
  id: string;
  kind: string;
  title: string;
  systemId: string | null;
  artworkRole: string | null;
  contentAvailable: boolean;
  identityConflict: boolean;
}
export interface WorkflowSourceFacts {
  sourceId: string;
  name: string;
  systemId: string | null;
  sourceValidator: string;
  selectionRevision: number;
  currentValueDigest: string;
  selected: WorkflowSelectionSummary[];
  evidenceIds: string[];
}
export interface WorkflowCatalogCandidate {
  id: string;
  kind: string;
  title: string;
  systemId: string | null;
  artworkRole: string | null;
  providerId: string;
  evidenceClass: 'verified-source' | 'saved-selection' | 'filename' | 'local' | 'unverified';
  identityConflict: boolean;
  agreesWithSelection: boolean;
  evidenceIds: string[];
}
export interface WorkflowCatalogResult {
  facts: WorkflowSourceFacts;
  candidates: WorkflowCatalogCandidate[];
  problems: { providerId: string; code: string }[];
  supportedIdentity: boolean;
}
export interface WorkflowObservation {
  sourceId: string;
  kind: WorkflowFindingKind;
  reason: string;
  evidenceIds: string[];
  candidateIds: string[];
}
export interface WorkflowProposalSuggestion {
  sourceId: string;
  findingId: string;
  action: CleanupChange['action'];
  candidateId: string;
  evidenceIds: string[];
  reason: string;
}
