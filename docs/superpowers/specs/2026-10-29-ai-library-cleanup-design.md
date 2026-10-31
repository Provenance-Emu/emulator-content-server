# AI workflow plugins and library cleanup

Status: approved by the user on 2026-10-29 for implementation planning. Implementation plan: `docs/superpowers/plans/2026-10-29-ai-library-cleanup.md`. No runtime, schema, dependency or generated-client changes accompany these documents.

## Intent and agreed direction

Help an owner find bad saved matches and missing or questionable front artwork, then review and apply fixes in a batch. Users can supply AI API keys or use their own assistant through MCP. Ship useful integrations while allowing community workflows, backend translators and tool integrations to be installed and updated independently.

The user chose the plugin/translator direction over putting backend-specific AI behavior into the content server. Text, image inspection, image generation and video generation are distinct capabilities and may have different backends and execution lifecycles. A general-purpose chat application is not required to deliver cleanup.

Proposed defaults, not explicit user decisions: only the server owner installs executable code; initial cleanup execution, review and connection management are owner-only, matching current matching permissions. Wider account-specific connections and delegated plugin installation remain outside the first implementation. All cleanup changes require explicit batch review. Original game files are not moved, renamed, patched or deleted by cleanup.

## Existing foundations and constraints

- `packages/plugins` defines `ecs.plugin/1`, seven existing plugin kinds, matching provider/manager interfaces, and the isolated matching bridge. Managers select providers; they are not durable workflows. Manifest parsing rejects unknown kinds and keys.
- `apps/plugins` hosts operator-installed integrations and consumes the content API. It cannot import the database, storage or server. `packages/plugins` has no internal package dependencies. SDK dependencies and installed modules execute outside the HTTP process.
- Current matching jobs persist in SQLite, process bounded pages, preserve saved choices, support interruption/resume and share review state across owner sessions. Existing identification readers supply bounded facts before online matching; see `docs/operations/rom-identification-plugins.md` for current representation limits.
- Selection writes use expected revisions. They may invoke automatic organization. Cleanup must have an explicitly metadata/artwork-only application path that does not trigger organization.
- Current live matching proposals expire after fifteen minutes. A durable cleanup proposal cannot just retain their request/candidate IDs and expect a later save to work.
- Existing child-process separation is not an OS sandbox. Installed JavaScript has the operator's OS permissions. Manifest declarations and host-mediated calls do not contain malicious code.
- The public OpenAPI contract and generated clients remain authoritative for HTTP additions. Existing plugin manifests, matching jobs and API responses keep their current semantics.

## Approaches

1. Add AI matching providers only. Smallest integration, but saved-choice auditing, durable multi-step work, different media lifecycles and batch undo do not fit the current search interface.
2. Add capability-based workflows and translators to the separate plugin host; share durable proposals and approval in the content API. This is the selected direction. It permits independent integrations while retaining one authority for library changes. It requires new contracts and job/application records.
3. Make cleanup an external MCP-only assistant. Useful access path, but cannot provide the requested built-in API-key workflow by itself.

Use approach 2; MCP is an additional access path to the same task and proposal contracts. This is a project spanning several packages, delivered in focused stages rather than a new service for every adapter.

## Contract boundaries

| Component | Responsibility | Must not own |
| --- | --- | --- |
| Workflow plugin | Task logic, prompts, step planning, findings and proposed fixes | Database writes, approval authority, credentials belonging to other bindings |
| Translator plugin | Translate a capability operation to a configured backend; normalize outputs, errors and usage | Library mutation, workflow policy, arbitrary credential lookup |
| Tool plugin | Adapt a data source or tool, including approved MCP operations | Implicit access to every available external tool |
| Plugin host | Resolve bindings, execute workers, hold connection secrets, track external operations and enforce normal invocation limits | Direct access to the content catalog/blob directory |
| Content API | Authorize library facts, persist durable run/proposal records and staged artifacts, validate evidence, apply approvals and conditional undo | Import installed modules or third-party model SDKs |

Retain existing storage connectors, matching providers and managers unchanged. A bundled tool adapter exposes existing matching/identification behavior through authorized APIs; do not duplicate ROM readers in an AI plugin. New plugin kinds are `workflow`, `translator` and `tool` under `ecs.plugin/2`. The loader supports both engine majors, rather than accepting new fields in the strict v1 parser. HTTP remains `/api/v1`: additive routes/models do not require changing the public API major.

## Manifest, capability and connection contracts

A v2 manifest has `id`, `name`, semantic `version`, `engine`, relative `.mjs` entry, host compatibility range and role-specific declarations. It names bounded local JSON Schema documents for configuration and operation input/output. Schema dialect is JSON Schema 2020-12; reject external references, executable validators and unbounded schema nesting. Unknown major contracts fail discovery before module execution.

Workflow example; IDs and schema filenames are proposed contract names:

```json
{
  "id": "org.ecs.library-cleanup",
  "name": "Library cleanup",
  "version": "1.0.0",
  "engine": "ecs.plugin/2",
  "hostApi": "^1.0.0",
  "kind": "workflow",
  "entry": "workflow.mjs",
  "inputSchema": "schemas/cleanup-input.json",
  "outputSchema": "schemas/cleanup-output.json",
  "bindings": {
    "catalog": { "capability": "catalog.search", "major": 1 },
    "reasoner": {
      "capability": "text.generate",
      "major": 1,
      "requires": { "structuredOutput": true },
      "optional": true
    },
    "coverInspector": {
      "capability": "image.inspect",
      "major": 1,
      "optional": true
    }
  },
  "effects": ["library.read", "proposal.create"]
}
```

The generic operation envelope is shared; inputs/outputs and options are specific to each versioned capability. Initial standardized operations are `catalog.search@1`, `text.generate@1` and `image.inspect@1`. Reserve independent future contracts for image generation/editing and video generation; do not promise those implementations in the cleanup slice. Namespaced community capabilities are allowed, but unknown capabilities have no implicit host authority.

Installed translators advertise possible capabilities. `describe(connection)` resolves actual endpoint/model capabilities, input media types, limits, structured output, resumability and cancellation. A workflow binding names required behavior rather than a vendor or SDK. The host rejects an incompatible binding before any paid work. Capability discovery itself cannot make a paid generation call.

A connection has an opaque ID, translator ID/version, endpoint, optional model ID, non-secret configuration, credential reference and allowed use. Multiple connections may use one translator. The host resolves workflow role names to connection IDs at run creation. Persist the mapping, plugin digests, schema versions, prompt/template versions, model identifier and configuration digest. Do not claim hosted model weights are immutable merely because a model name is recorded.

Connection configuration can restrict transmitted fields, image inspection and fallback destinations. Default cloud input is bounded title/system/edition metadata, candidate evidence and a basename where needed. No ROM/save/BIOS bytes, full local paths or ECS credentials go to AI backends. Images require an explicit run option and an image-capable binding. Catalog failures are reported separately from missing results. No silent fallback to a different credential, cloud provider or data-sharing scope.

Credentials live in plugin-host private state, outside manifests, the content database and normal diagnostic exports. User entry passes through an authenticated management operation and is never returned by reads or stored in browser persistence. Raw values are available only to the translator worker selected for that connection; workflows receive opaque bindings. A host fetch helper can inject credentials for supported HTTP translators. A trusted native SDK translator may require worker-local access to its selected credential. This is a trust reduction, not a sandbox guarantee. Credential revocation prevents new calls and resume; it does not invalidate already approved public artwork snapshots.

## Workflow execution and operation lifecycle

Use an explicit state-machine contract rather than replaying arbitrary JavaScript closures. A workflow exports `advance(snapshot)`, returning a bounded next-step plan and JSON checkpoint, or a completed output. The snapshot contains authorized input, stored checkpoint and completed step results. A plan requests host calls through named bindings and may emit findings/proposals. Waiting, artifact transport and retries belong to the host.

Each requested step has a stable ID, capability major, binding role, input and an input digest computed by the host. Repeating the same ID/input reuses the recorded result; repeating an ID with different input is a contract error. Initial execution is sequential within a source; the host controls bounded concurrency between sources. Limits apply to calls, steps, output sizes, duration and retries. Workflow code is expected to plan without its own external I/O; trusted-code execution cannot enforce that expectation by declaration alone.

Conceptual transport shapes, not complete TypeScript declarations:

```ts
type OperationRequest = {
  operationId: string;
  capability: string;
  major: number;
  input: JsonValue;
  deadline: string;
};

type OperationResult =
  | { state: 'completed'; output: JsonValue; usage?: Usage }
  | { state: 'pending'; resumeHandle: JsonValue; pollAfterMs: number }
  | { state: 'failed'; error: OperationError };
```

Translator methods are `describe`, `start`, and, when advertised, `poll` and `cancel`. Abort signals and credential access are worker-context facilities, not serialized request fields. `poll` uses the same operation ID and a private backend handle. Handles are persisted as sensitive plugin-host state and not exposed to models, MCP clients or public job responses. Persist a step result and the corresponding workflow checkpoint in one host-local transaction before scheduling the next step. Worker replies require a current lease/fencing value; an old worker cannot publish after reassignment.

Normalized errors distinguish invalid input, authentication, rate limit, unsupported capability, timeout, unavailable backend, invalid output and uncertain submission. Include bounded retry-after hints without raw provider responses or secrets. Retry safe reads with bounded backoff. Retry paid submission only when backend idempotency or a confirmed not-submitted outcome supports it; otherwise retain an uncertain operation for reconciliation. Cancellation stops new work and requests backend cancellation when supported; it cannot promise refund or cancellation of an accepted remote job.

First-slice budgets enforce call/token/output ceilings and stop scheduling at the configured estimated spending threshold. Store estimated versus reported cost and currency separately; unknown pricing is visible. An application-side estimate is not a guaranteed provider billing cap. Resume rechecks authorization, connection availability and budget. Completed step caches are run-scoped initially; no cross-user prompt/result cache.

## Service communication and persistence ownership

The content API owns run scope, findings, proposal versions, approval/application receipts and library-facing artifacts in SQLite/storage. Reuse the existing queue's bounded paging and conflict-control patterns, without changing `scan`/`match` job behavior or requiring old clients to understand workflow job states. Introduce separate additive workflow-run resources with a typed cleanup result projection.

The plugin host owns installation/configuration metadata, secret references, external handles and execution-local checkpoints. It has its own private state directory and persistence file; it does not open the server's database. The API stores a public step ledger and opaque checkpoint reference sufficient to distinguish completed versus interrupted work. Host state must survive a host restart; restoring only the content database cannot recover a lost paid-operation handle. Document both parts in backup/restore, excluding raw secrets from default exports.

The host connects outbound to the content API as an owner-provisioned service identity. The owner creates/revokes this identity through an authenticated server operation and transfers the one-time enrollment credential to the host. Enrollment does not make the identity an owner session. Define narrowly scoped worker credentials for claiming assigned runs, reading their authorized facts and publishing staged output. Credentials bind a host installation to assigned runs; the server checks the initiating owner's current authority and the run's library scope on every claim, read and publication. Workers cannot approve proposals, apply selections, manage users or install plugins through those credentials. Plugin modules do not receive the service credential. Revoking the identity stops claims and publication; ordinary owner browser sessions retain the existing owner permission checks.

Use a leased outbound claim/control loop with bounded long polling; no distributed broker is required. API commands carry unique IDs and public state publications carry monotonic per-run sequence numbers. After a host-local step commit, publish its result/proposals idempotently and wait for the API acknowledgement before advancing. A crash after local commit replays publication, not inference. A crash after backend acceptance but before saving its handle remains an uncertain submission unless the backend can reconcile it. The API fences expired claims and rejects out-of-order/conflicting publication. The same host can reclaim and reconcile its durable run; another host cannot execute it without an explicit transfer of compatible private state and pinned packages. Lost host state marks the run as requiring recovery, rather than authorizing a new paid call.

Host-management operations (list/install/activate plugins and create/test/revoke connections) use an authenticated same-origin content API facade relayed over the outbound host control channel. Only non-secret summaries persist in the content catalog. If the plugin host is absent, core library operations work and workflow management returns an unavailable status. Do not expose a second unauthenticated management listener. Generated client methods back both web and tray; neither imports plugin runtime code. UI uses bundled controls driven by validated configuration schemas, not executable plugin-supplied UI.

## Findings, evidence, proposals and artifacts

A finding identifies a problem even if no fix exists. Kinds initially include `identity-conflict`, `suspected-mismatch`, `missing-front-artwork`, `questionable-front-artwork` and `unavailable-selected-artwork`. Provider outage/unsupported identification is an execution issue, not evidence that metadata is wrong. Findings include a source identity validator, saved-selection revision, category/role, concise explanation and evidence references.

Evidence records distinguish server-validated source facts, attributed catalog records, explicit filename associations and model observations. Imported plugin/MCP observations never become server-verified hashes based on their self-description. The normal matching validator checks candidate consistency and contradictions against retained trusted facts. Regions, revisions, prototypes, homebrew and translations remain distinct when supported by the evidence. Model certainty is not checksum confidence.

A proposal contains a server-assigned ID/version, finding ID, source ID, expected source validator and selection revision, target metadata category or artwork role, expected current-value digest, proposed snapshot, evidence references and human-readable reason. Workflow/model provenance is attached by the host/API rather than trusted from arbitrary model output. Initial actions replace metadata/system selections or set/replace front artwork; no source-file mutation actions exist.

Catalog candidates are materialized into immutable, bounded metadata snapshots when the proposal is created. Model output references candidates/evidence that the run already received; model-supplied attribution alone cannot create a catalog receipt. A community tool's independently sourced metadata remains attributed to that tool and unverified until the normal evidence checks corroborate it. Artwork is fetched, validated and staged through a generalized authorized resource bridge at proposal time, with digest, media type, dimensions, source attribution and licensing facts where supplied. Existing generic provider URLs are not sufficient authorization to fetch arbitrary destinations. Validate configured origins, resolved addresses, redirects, bytes, type and dimensions, including explicitly approved local-service destinations. Reject unapproved requests before forwarding credentials. A persisted proposal does not depend on an expiring URL or live matching-preview cache.

Artifact references are opaque and scoped to their run/source; they confer neither arbitrary filesystem access nor unrestricted downloads. Enforce current library access on each read. Limit staged bytes per run and per host/library, and bound proposals/candidates per source; reaching a quota stops new staging with a recoverable capacity error and preserves existing review work. First cleanup art uses the existing bounded raster formats/limits; PDF/manual/video outputs are outside this slice. Generated art later uses the same staging path with explicit generated provenance, not an invented catalog attribution.

## Cleanup behavior and batch review

1. Owner selects one library/root or bounded explicit source selection, permitted providers, optional AI bindings, image sharing and limits. First release covers indexed server-folder games, consistent with current matching; managed-upload coverage is a separate extension. Freeze the work list/validators without holding a long database transaction.
2. Build read-only snapshots and identify only within existing reader bounds. Reuse valid cached facts and do not turn cleanup into an unrequested full-file rehash. Sources outside those bounds remain uncertain.
3. Search permitted matching providers and run deterministic checks against saved choices. The inspection path never performs the ordinary matching queue's automatic saves.
4. Without AI, publish deterministic findings/proposals. With AI, ask text reasoning only about uncertain cases. Optional vision compares the current/candidate covers. Both produce schema-validated observations and references, never authority to apply.
5. Persist paginated findings and proposals as work completes. Background completion means inspection finished, not that the library changed. Findings can remain unresolved when no defensible replacement exists.
6. Owner accepts selected proposal versions, picks alternatives, rejects a proposed fix, or keeps an intentional existing choice. A keep/dismiss decision is keyed to the finding rule/version, relevant current-value digest and evidence digest. It survives reruns until those relevant inputs change; unrelated catalog updates do not reset every dismissal.
7. Approval stores an immutable list of proposal IDs/versions and content digests tied to the owner, run and current batch revision. Applying cannot silently include new/revised proposals. Read/approval/apply may be separate requests; apply requires that exact approval record. Proposed target changes invalidate approval.
8. Recheck permission, source identity, current selection revision and staged content before each source transaction. Related metadata/system/artwork changes for one source validate together and commit atomically at its current revision. Reject approval of mutually exclusive alternatives targeting the same selection slot. Across sources the batch reports partial success, conflicts and failures. Retrying an application ID returns committed receipts rather than repeating changes.
9. Save prior selections and referenced artwork for conditional undo. Undo restores only when current selections still match the application's post-state; later edits return a conflict. Artwork generated/fetched for review is never automatically treated as the original file.

Retain unfinished and pending-review runs until explicit owner deletion. Completed/rejected staging and undo snapshots have a proposed 30-day retention, shown with an expiry; approved selections keep their referenced content independently. Deleting a run with pending review requires explicit confirmation and cannot delete currently selected artwork. Undo retention and staging cleanup must reference-count shared artifacts. Cancelling inspection preserves completed findings and proposals; an interrupted run resumes from stored steps. Plugin updates never auto-apply fixes.

## MCP access

The ECS MCP adapter is a separate plugin-host service using the same content API. Initial deployment supports a local stdio adapter with an owner-provisioned scoped token. Tools are intentionally small: start inspection, read run/progress, page findings/proposals and submit additional suggestions. An external assistant's own inference requires no ECS model key. Suggestions enter the same untrusted-observation and proposal validation path. Tokens are scoped to allowed libraries and investigation/proposal operations; library content and keys are not exposed merely by listing tools.

Initial MCP tools cannot approve or apply. The user completes batch approval/application in ECS; an assistant's assertion that the user approved is not an approval record. Remote HTTP MCP deployment with its authentication/discovery requirements is a later transport, not an undocumented reuse of a broad owner bearer token.

An inbound tool connector is separately configurable: bind an explicit external MCP server/tool and validated input/output schema to a workflow role. Treat tool descriptions/results as untrusted data, bound their size and never grant new tools or side effects based on returned text. Mutation or paid external tools require an explicit declared effect and owner-approved run option. Generic arbitrary-tool execution is not a default cleanup capability. External tool calls also enter the durable operation ledger; safe retries depend on their actual effects.

## Distribution, updates and trust

Defaults use the same manifest/activation path as community packages. First installation accepts an owner-supplied bundle or a trusted local development directory; no public registry or runtime `npm install` is required. Bundles include their runtime dependency closure; activation does not run package lifecycle hooks. Validate archive containment, links, expansion/file-count limits, manifest/schema compatibility and package digest before importing an entry. Do not modify dependencies shared by another installed plugin.

Activation is an explicit owner action. Publish a new immutable version directory and switch an active-version pointer atomically. Pin workflow, translator, tool, configuration and schema digests per run. Existing workers continue with their pinned packages; new runs use the activated versions. Keep referenced old versions until runs and retained receipts release them. Updates cannot silently expand credential grants, external destinations or library access; changed grants need a new owner configuration decision. An emergency disable blocks new steps/resume, including pinned old code, while leaving already materialized proposals available for review.

Process restart is the update boundary; do not hot-replace imported modules or migrate live JavaScript closures. Rollback chooses a retained compatible version for new runs; it does not migrate an interrupted run's checkpoint to a different plugin version. A remote service's handshake detects contract mismatch, but ECS cannot guarantee immutability of independently deployed remote code. Initial remote backends are reached through local translators; hosting arbitrary remote workflow implementations is deferred.

Owners are trusting installed community code as the OS account. Restricted worker messages, isolated translator credentials and separate processes reduce accidental cross-talk; they are not a hostile-plugin security boundary. Running untrusted user-installed code would require an actual sandbox/container design and is outside this proposal. Package hashes identify exact bytes; signatures or a curated registry would add distribution assurance, not make arbitrary code safe.

## Initial delivery scope and acceptance

First deliver the v2 contracts and durable execution/staging/application path, a bundled deterministic cleanup workflow, optional text/vision translators and a working community sample workflow/translator. Proposed default backend integrations are OpenAI, Anthropic, Google and a configurable OpenAI-compatible endpoint for local or gateway use; each advertises only the tested operations for the chosen endpoint/model. Hosted integrations belong to this feature's initial scope, but may be added one adapter at a time after the deterministic and first backend paths work. Keep the SDK behind translator contracts; choose and pin it during planning after verifying the required endpoint/model matrix. A configured endpoint is supported only for its validated capabilities, not every API described as compatible. Vision is opt-in and only available on bindings that support it.

The next increment adds the stdio ECS MCP adapter and an explicit external-MCP tool binding, using the same validated cleanup records. These increments form this feature's delivery scope; image/video generation, remote HTTP MCP, public marketplace, ordinary-account code installation and unattended fixes are follow-ons. Do not require implementing every future modality before library cleanup is usable.

Acceptance checks use generated catalog facts and raster bytes plus fake translators/backends. Cover deterministic cleanup without keys, conflicting saved matches, unsupported readers, provider outages, invalid model output, preserved editions and private-data exclusion. Exercise batch approval binding, per-source atomicity, stale source/selection conflicts, retried apply, conditional undo, artwork retention and suppression of organization side effects. Exercise worker restart/fencing, saved checkpoints, uncertain paid submission, budget/cancellation, credential revocation, version activation/disable, v1 compatibility and bundle containment. MCP tests include suggestion validation, library scopes and inability to approve/apply. Run affected package tests/typechecks and generated-client drift for changed HTTP contracts, plus one proportionate review for the auth/storage/concurrency portions; avoid unrelated native/release matrices.

## Implementation allocation and remaining builder choices

- `packages/plugins`: v2 pure schemas/contracts/validation, runtime message contracts and old-provider adapters. No catalog imports.
- `apps/plugins`: host/control channel, private state, bundle installation/activation, workflow/translator/tool workers, shipped adapters and MCP service.
- `packages/protocol` and generated clients: additive workflow/proposal/artifact/worker/control operations and typed cleanup models.
- `packages/domain`, `packages/database`, `packages/storage`, `packages/auth`: typed ports, numbered migrations, durable records, artifact lifetime and narrow authorization as required by these contracts.
- `apps/server`: API validation, leases, evidence/resource bridge, approval/application and conditional undo. Installed modules stay out of process.
- `apps/web` and shared tray interface: connection/plugin management and paged batch review through `@ecs/client`; no plugin runtime imports. Interaction/layout mockups remain a separate design discussion.

The builder may settle exact endpoint names, SQL table layout, validation library, JSON checkpoint limits, worker concurrency defaults and bundle format within the documented boundaries. These are implementation choices, not reasons to broaden the feature. Owner-only installation/management, the default backend set, local-first MCP transport and 30-day retention were presented as defaults and accepted with the design approval on 2026-10-29. The implementation plan records the concrete first-slice limits and module boundaries.

Builder check: the requested Sonnet review was attempted with tools disabled, but local Claude authentication failed because the OAuth session had expired. An author-side planning-gap review clarified enrollment/scoped worker authorization, crash/publication ordering across the two state stores, candidate provenance, artifact quotas, conflicting batch alternatives and the proposed default backend set. This is not an independent-review claim; an independent check remains advisable before implementation planning.

## Reference material

- Existing architecture: `docs/architecture/decisions/0007-plugin-host.md`.
- Existing matching and evidence: `docs/operations/matching-plugins.md`, `docs/operations/rom-identification-plugins.md`.
- Existing queue behavior: `docs/operations/shared-library-jobs.md`.
- SDK candidate: [AI SDK provider capability matrix](https://ai-sdk.dev/providers/ai-sdk-providers). An SDK is a translator implementation detail, not the ECS plugin ABI.
- MCP concepts: [official architecture overview](https://modelcontextprotocol.io/docs/learn/architecture). Negotiate and implement the pinned SDK/protocol supported during the implementation phase rather than copying discovery/auth assumptions into these contracts.
