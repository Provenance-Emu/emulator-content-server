import {
  type ContentClient,
  ContentError,
  type SourceMatchSelections,
  type WorkflowApplication,
  type WorkflowApproval,
  type WorkflowFinding,
  type WorkflowHost,
  type WorkflowProposal,
  type WorkflowRun,
  type WorkflowRunDraft,
  type WorkflowScope,
} from '@ecs/client';
import { writable } from 'svelte/store';
import { readBatches } from './batches.js';
import { explain } from './problems.js';

type CleanupClient = Pick<
  ContentClient,
  | 'workflowHosts'
  | 'workflowRuns'
  | 'workflowRun'
  | 'workflowProposals'
  | 'workflowFindings'
  | 'workflowResults'
  | 'sourceSelections'
  | 'workflowApplications'
  | 'createWorkflowRun'
  | 'decideWorkflowFinding'
  | 'approveWorkflowBatch'
  | 'applyWorkflowApproval'
  | 'workflowApplicationBatch'
  | 'undoWorkflowApplication'
  | 'cancelWorkflowRun'
  | 'resumeWorkflowRun'
>;
export interface CleanupReviewState {
  scope: WorkflowScope;
  hosts: WorkflowHost[];
  runs: WorkflowRun[];
  run: WorkflowRun | null;
  proposals: WorkflowProposal[];
  findings: WorkflowFinding[];
  selected: WorkflowProposal[];
  selections: Record<string, SourceMatchSelections>;
  applications: WorkflowApplication[];
  approval: WorkflowApproval | null;
  results: { sourceId: string; outputJson?: string }[];
  nextProposalsCursor: string | null;
  nextFindingsCursor: string | null;
  nextApplicationsCursor: string | null;
  nextRunsCursor: string | null;
  loading: boolean;
  failure: string | null;
  notice: string | null;
}
export function createWorkflowRuns(
  client: CleanupClient,
  scope: WorkflowScope,
  hooks: { changed?: () => void; rejected?: (status: 401 | 403) => void } = {},
) {
  const empty = (): CleanupReviewState => ({
    scope: { ...scope },
    hosts: [],
    runs: [],
    run: null,
    proposals: [],
    findings: [],
    selected: [],
    selections: {},
    applications: [],
    approval: null,
    results: [],
    nextProposalsCursor: null,
    nextFindingsCursor: null,
    nextApplicationsCursor: null,
    nextRunsCursor: null,
    loading: false,
    failure: null,
    notice: null,
  });
  let current = empty(),
    epoch = 0,
    disposed = false,
    denied = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  // How many batches of each list are shown. Every reload reads that many again.
  const depth = { proposals: 1, findings: 1, applications: 1, runs: 1 };
  const distinct = <T>(rows: T[], key: (row: T) => string) => [
    ...new Map(rows.map((row) => [key(row), row])).values(),
  ];
  let startAttempt: { signature: string; key: string } | undefined,
    approvalAttempt: { signature: string; key: string; revision: number } | undefined,
    applicationId: string | undefined;
  const store = writable(current);
  function emit(change: Partial<CleanupReviewState>) {
    current = { ...current, ...change };
    store.set(current);
  }
  function valid(e: number) {
    return !disposed && !denied && epoch === e;
  }
  function fail(error: unknown, e: number) {
    if (!valid(e)) return;
    if (error instanceof ContentError && [401, 403].includes(error.status)) {
      epoch++;
      denied = true;
      current = empty();
      current.failure = explain(error);
      store.set(current);
      hooks.rejected?.(error.status as 401 | 403);
      return;
    }
    emit({ failure: explain(error) });
  }
  async function action(work: (e: number) => Promise<void>) {
    if (disposed || denied || current.loading) return;
    const e = epoch;
    emit({ loading: true, failure: null });
    try {
      await work(e);
    } catch (error) {
      fail(error, e);
    } finally {
      if (valid(e)) emit({ loading: false });
    }
  }
  function invalidateApproval() {
    approvalAttempt = undefined;
    applicationId = undefined;
    emit({ approval: null });
  }
  async function load(e: number, id: string) {
    // Each batch of fixes carries the findings its fixes answer.
    const proposalFindings: WorkflowFinding[] = [];
    const [r, p, f, a, results] = await Promise.all([
      client.workflowRun(id),
      readBatches(depth.proposals, async (cursor) => {
        const batch = await client.workflowProposals(id, cursor);
        proposalFindings.push(...(batch.findings ?? []));
        return batch;
      }),
      readBatches(depth.findings, (cursor) => client.workflowFindings(id, cursor)),
      readBatches(depth.applications, (cursor) => client.workflowApplications(id, cursor)),
      client.workflowResults(id),
    ]);
    if (!valid(e)) return;
    const selections: Record<string, SourceMatchSelections> = {};
    await Promise.all(
      [...new Set(p.items.map((row) => row.sourceId))].map(async (sourceId) => {
        try {
          selections[sourceId] = await client.sourceSelections(sourceId);
        } catch (error) {
          if (error instanceof ContentError && [401, 403].includes(error.status)) throw error;
        }
      }),
    );
    if (!valid(e)) return;
    const findingMap = new Map([...f.items, ...proposalFindings].map((row) => [row.id, row]));
    const selected = current.selected.filter(
      (saved) =>
        !p.items.some(
          (row) =>
            row.id === saved.id && (row.version !== saved.version || row.digest !== saved.digest),
        ) && !findingMap.get(saved.findingId)?.dismissed,
    );
    if (selected.length !== current.selected.length) {
      invalidateApproval();
      emit({ notice: 'A selected fix changed or was reviewed. Review it again before approval.' });
    }
    emit({
      run: r.run,
      proposals: distinct(p.items, (row) => `${row.id}:${row.version}`),
      findings: [...findingMap.values()],
      selected,
      selections,
      applications: distinct(a.items, (row) => row.id + row.sourceId),
      results: results.items,
      nextProposalsCursor: p.nextCursor,
      nextFindingsCursor: f.nextCursor,
      nextApplicationsCursor: a.nextCursor,
    });
  }
  async function history(e: number) {
    const [h, r] = await Promise.all([
      client.workflowHosts(),
      readBatches(depth.runs, (cursor) => client.workflowRuns({ ...current.scope, cursor })),
    ]);
    if (valid(e))
      emit({
        hosts: h.items,
        runs: distinct(r.items, (row) => row.id),
        nextRunsCursor: r.nextCursor,
      });
  }
  async function refresh() {
    await action(async (e) => {
      await history(e);
      if (!valid(e)) return;
      const id = current.run?.id ?? current.runs[0]?.id;
      if (id) await load(e, id);
    });
  }
  async function choose(id: string) {
    if (disposed || denied) return;
    epoch++;
    depth.proposals = depth.findings = depth.applications = 1;
    approvalAttempt = undefined;
    applicationId = undefined;
    emit({
      run: null,
      proposals: [],
      selected: [],
      findings: [],
      applications: [],
      approval: null,
      selections: {},
      loading: false,
      notice: null,
    });
    await action((e) => load(e, id));
  }
  /** Shows one more batch of a list, below what is already there. */
  async function more(which: keyof typeof depth) {
    await action(async (e) => {
      if (which === 'runs') {
        if (!current.nextRunsCursor) return;
        depth.runs++;
        await history(e);
        return;
      }
      const id = current.run?.id;
      const next = {
        proposals: current.nextProposalsCursor,
        findings: current.nextFindingsCursor,
        applications: current.nextApplicationsCursor,
      }[which];
      if (!id || !next) return;
      depth[which]++;
      await load(e, id);
    });
  }
  function select(p: WorkflowProposal, checked: boolean) {
    if (current.loading || disposed || denied) return;
    invalidateApproval();
    let selected = current.selected.filter((row) => row.id !== p.id);
    if (checked) {
      selected = selected.filter(
        (row) => row.sourceId !== p.sourceId || row.change.action !== p.change.action,
      );
      selected.push(structuredClone(p));
    }
    emit({ selected });
  }
  async function decide(id: string, decision: 'keep' | 'dismiss') {
    await action(async (e) => {
      if (!current.run) return;
      const { finding } = await client.decideWorkflowFinding(current.run.id, id, decision);
      if (!valid(e)) return;
      invalidateApproval();
      emit({
        findings: current.findings.map((row) => (row.id === id ? finding : row)),
        selected: current.selected.filter((row) => row.findingId !== id),
        notice: decision === 'keep' ? 'Kept the current selection.' : 'Dismissed this finding.',
      });
    });
  }
  async function approve() {
    await action(async (e) => {
      if (!current.run || !current.selected.length) return;
      const refs = current.selected
        .map(({ id, version, digest }) => ({ id, version, digest }))
        .sort((a, b) => a.id.localeCompare(b.id));
      const signature = JSON.stringify([current.run.id, refs]);
      if (approvalAttempt?.signature !== signature)
        approvalAttempt = { signature, key: crypto.randomUUID(), revision: current.run.revision };
      const { approval } = await client.approveWorkflowBatch(
        current.run.id,
        approvalAttempt.revision,
        refs,
        approvalAttempt.key,
      );
      if (valid(e))
        emit({
          approval,
          notice: `Approved ${refs.length} selected fix${refs.length === 1 ? '' : 'es'}. Apply to save them.`,
        });
    });
  }
  async function apply() {
    await action(async (e) => {
      if (!current.approval) return;
      applicationId ??= crypto.randomUUID();
      const id = applicationId;
      let applications: WorkflowApplication[];
      try {
        ({ applications } = await client.applyWorkflowApproval(current.approval.id, id));
      } catch (error) {
        if (error instanceof ContentError && [401, 403].includes(error.status)) throw error;
        const recovered = await client.workflowApplicationBatch(id).catch((recoveryError) => {
          if (recoveryError instanceof ContentError && [401, 403].includes(recoveryError.status))
            throw recoveryError;
          return null;
        });
        if (!recovered?.applications.length) throw error;
        applications = recovered.applications;
      }
      if (!valid(e)) return;
      // A batch may have committed only some sources before a disconnect. A replay completes the rest.
      const approved = JSON.parse(current.approval.proposalVersionsJson) as { id: string }[];
      const done = new Set(
        applications.flatMap((row) => {
          try {
            return (JSON.parse(row.resultJson).proposals ?? []).map((p: { id: string }) => p.id);
          } catch {
            return [];
          }
        }),
      );
      const complete = approved.every((p) => done.has(p.id));
      emit({
        applications,
        selected: current.selected.filter((p) => !done.has(p.id)),
        approval: complete ? null : current.approval,
        notice: `${applications.filter((a) => a.status === 'applied').length} source${applications.filter((a) => a.status === 'applied').length === 1 ? '' : 's'} updated. ${applications.filter((a) => a.status === 'conflict' || a.status === 'failed').length} need another review.${complete ? '' : ' Apply again to finish the remaining approved sources.'}`,
      });
      if (complete) {
        applicationId = undefined;
        approvalAttempt = undefined;
      }
      hooks.changed?.();
    });
  }
  async function undo(application: WorkflowApplication) {
    await action(async (e) => {
      const result = await client.undoWorkflowApplication(application.id, application.sourceId);
      if (valid(e)) {
        emit({
          applications: current.applications.map((row) =>
            row.id === application.id && row.sourceId === application.sourceId
              ? result.application
              : row,
          ),
          notice: 'Restored the previous selections.',
        });
        hooks.changed?.();
      }
    });
  }
  async function start(draft: WorkflowRunDraft) {
    await action(async (e) => {
      const signature = JSON.stringify(draft);
      if (startAttempt?.signature !== signature)
        startAttempt = { signature, key: crypto.randomUUID() };
      const { run } = await client.createWorkflowRun(draft, startAttempt.key);
      if (valid(e)) {
        depth.proposals = depth.findings = depth.applications = 1;
        emit({ run, selected: [], approval: null });
        await load(e, run.id);
        await history(e);
        startAttempt = undefined;
      }
    });
  }
  async function lifecycle(kind: 'cancel' | 'resume') {
    await action(async (e) => {
      if (!current.run) return;
      const result = await (kind === 'cancel'
        ? client.cancelWorkflowRun(current.run.id)
        : client.resumeWorkflowRun(current.run.id));
      if (valid(e)) emit({ run: result.run });
    });
  }
  function connect() {
    if (timer || disposed) return;
    void refresh();
    const tick = () => {
      timer = setTimeout(() => {
        void refresh().finally(() => {
          if (!disposed && !denied) tick();
        });
      }, 2500);
    };
    tick();
  }
  function dispose() {
    disposed = true;
    epoch++;
    if (timer) clearTimeout(timer);
    current = empty();
    store.set(current);
  }
  async function setScope(next: WorkflowScope) {
    epoch++;
    scope = { ...next };
    depth.proposals = depth.findings = depth.applications = depth.runs = 1;
    startAttempt = approvalAttempt = undefined;
    applicationId = undefined;
    current = empty();
    store.set(current);
  }
  return {
    subscribe: store.subscribe,
    refresh,
    choose,
    connect,
    setScope,
    start,
    select,
    decide,
    approve,
    apply,
    undo,
    cancel: () => lifecycle('cancel'),
    resume: () => lifecycle('resume'),
    moreProposals: () => more('proposals'),
    moreFindings: () => more('findings'),
    moreApplications: () => more('applications'),
    moreRuns: () => more('runs'),
    dispose,
  };
}
