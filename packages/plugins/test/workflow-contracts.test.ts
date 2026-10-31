import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseManifest } from '../src/manifest.js';
import { discoverPlugin } from '../src/registry.js';
import {
  loadWorkflowPlugin,
  parseWorkflowManifest,
  validateCapabilityBinding,
  validateOperationResult,
  validateSchemaDocument,
  validateSchemaValue,
  validateWorkflowPlan,
} from '../src/workflows/index.js';

const manifest = () => ({
  id: 'org.example.cleanup',
  name: 'Cleanup',
  version: '1.0.0',
  engine: 'ecs.plugin/2',
  hostApi: '^1.0.0',
  kind: 'workflow',
  entry: 'workflow.mjs',
  inputSchema: 'schemas/input.json',
  outputSchema: 'schemas/output.json',
  effects: ['library.read', 'proposal.create'],
  bindings: {
    reasoner: {
      capability: 'text.generate',
      major: 1,
      optional: true,
      requires: { structuredOutput: true },
    },
  },
});
const schema = {
  type: 'object',
  additionalProperties: false,
  properties: { limit: { type: 'integer', minimum: 1 } },
  required: ['limit'],
};

test('v1 manifests stay strict while v2 discovers without executing entry code', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ecs-workflow-contract-'));
  try {
    await mkdir(join(directory, 'schemas'));
    await writeFile(join(directory, 'plugin.json'), JSON.stringify(manifest()));
    await writeFile(join(directory, 'schemas/input.json'), JSON.stringify(schema));
    await writeFile(join(directory, 'schemas/output.json'), JSON.stringify(schema));
    const marker = join(directory, 'executed');
    await writeFile(
      join(directory, 'workflow.mjs'),
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    );
    const loaded = await loadWorkflowPlugin(directory);
    assert.equal(loaded.manifest.id, 'org.example.cleanup');
    const discovered = await discoverPlugin(directory);
    assert.equal(discovered.engine, 'ecs.plugin/2');
    await assert.rejects(access(marker));
    assert.throws(() => parseManifest(manifest()));
    assert.equal(
      parseManifest({
        id: 'org.example.catalog',
        name: 'Catalog',
        version: '1',
        engine: 'ecs.plugin/1',
        kind: 'provider',
        entry: 'catalog.mjs',
        provider: { capabilities: ['metadata'], network: false },
      }).engine,
      'ecs.plugin/1',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery rejects paths and symlinks outside its package and incompatible host versions', async () => {
  assert.throws(() => parseWorkflowManifest({ ...manifest(), hostApi: '^2.0.0' }));
  assert.throws(() => parseWorkflowManifest({ ...manifest(), version: 'latest' }));
  assert.throws(() => parseWorkflowManifest({ ...manifest(), entry: '../outside.mjs' }));
  assert.throws(() => parseWorkflowManifest({ ...manifest(), entry: 'sub\\workflow.mjs' }));
  const directory = await mkdtemp(join(tmpdir(), 'ecs-workflow-path-'));
  const outside = await mkdtemp(join(tmpdir(), 'ecs-workflow-outside-'));
  try {
    await mkdir(join(directory, 'schemas'));
    await writeFile(join(directory, 'plugin.json'), JSON.stringify(manifest()));
    await writeFile(join(directory, 'schemas/input.json'), JSON.stringify(schema));
    await writeFile(join(directory, 'schemas/output.json'), JSON.stringify(schema));
    await writeFile(join(outside, 'external.mjs'), 'throw new Error("must not run");');
    await symlink(join(outside, 'external.mjs'), join(directory, 'workflow.mjs'));
    await assert.rejects(loadWorkflowPlugin(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('image inspection does not imply generation and capability majors must agree', () => {
  const offered = {
    capability: 'image.inspect',
    major: 1,
    features: {},
    inputMediaTypes: ['image/png'],
    maxInputBytes: 1024,
    maxOutputBytes: 1024,
    asynchronous: false,
    cancellation: false,
  };
  assert.doesNotThrow(() =>
    validateCapabilityBinding({ capability: 'image.inspect', major: 1 }, offered),
  );
  assert.throws(() =>
    validateCapabilityBinding({ capability: 'image.generate', major: 1 }, offered),
  );
  assert.throws(() =>
    validateCapabilityBinding({ capability: 'image.inspect', major: 2 }, offered),
  );
});

test('structured output is required by the reasoner binding', () => {
  const required = { capability: 'text.generate', major: 1, requires: { structuredOutput: true } };
  const offered = {
    capability: 'text.generate',
    major: 1,
    features: {},
    inputMediaTypes: [],
    maxInputBytes: 1024,
    maxOutputBytes: 1024,
    asynchronous: false,
    cancellation: false,
  };
  assert.throws(() => validateCapabilityBinding(required, offered));
  assert.doesNotThrow(() =>
    validateCapabilityBinding(required, { ...offered, features: { structuredOutput: true } }),
  );
});

test('malformed backend advertisements cannot satisfy a capability binding', () => {
  const offered = {
    capability: 'text.generate',
    major: 1,
    features: {},
    inputMediaTypes: [],
    maxInputBytes: 1024,
    maxOutputBytes: 1024,
    asynchronous: false,
    cancellation: false,
  };
  assert.throws(() =>
    validateCapabilityBinding({ capability: 'text.generate', major: 1 }, {
      ...offered,
      asynchronous: 'yes',
    } as unknown as typeof offered),
  );
  assert.throws(() =>
    validateCapabilityBinding({ capability: 'text.generate', major: 1 }, {
      ...offered,
      features: { arbitrary: 1 },
    } as unknown as typeof offered),
  );
});

test('external schema refs and secret-bearing manifests are rejected', () => {
  assert.throws(() => validateSchemaDocument({ $ref: 'https://example.invalid/schema.json' }));
  assert.throws(() =>
    validateSchemaDocument({ type: 'object', unknownExecutableKeyword: 'return true' }),
  );
  assert.throws(() => validateSchemaDocument({ type: 'not-a-json-schema-type' }));
  assert.throws(() =>
    parseWorkflowManifest({
      ...manifest(),
      bindings: {
        reasoner: { capability: 'text.generate', major: 1, apiKey: 'generated-not-a-key' },
      },
    }),
  );
  assert.throws(() => parseWorkflowManifest({ ...manifest(), effects: ['library.write'] }));
  assert.doesNotThrow(() =>
    parseWorkflowManifest({
      id: 'org.example.translator',
      name: 'Translator',
      version: '1.0.0',
      engine: 'ecs.plugin/2',
      hostApi: '^1.0.0',
      kind: 'translator',
      entry: 'translator.mjs',
      provides: [{ capability: 'text.generate', major: 1 }],
      credentials: ['apiKey'],
    }),
  );
});

test('schema validation does not coerce values or accept unknown fields', () => {
  const checked = validateSchemaDocument(schema);
  assert.doesNotThrow(() => validateSchemaValue(checked, { limit: 2 }));
  assert.throws(() => validateSchemaValue(checked, { limit: '2' }));
  assert.throws(() => validateSchemaValue(checked, { limit: 0 }));
  assert.throws(() => validateSchemaValue(checked, { limit: 2, extra: true }));
  const local = validateSchemaDocument({
    $defs: { count: { type: 'integer' } },
    $ref: '#/$defs/count',
  });
  assert.doesNotThrow(() => validateSchemaValue(local, 4));
});

test('workflow plans reject duplicate steps, non-JSON state and oversized checkpoints', () => {
  const operation = {
    id: 'inspect-1',
    binding: 'reasoner',
    capability: 'text.generate',
    major: 1,
    input: { title: 'Generated game' },
  };
  const plan = { state: 'waiting', checkpoint: { page: 1 }, operations: [operation] };
  assert.deepEqual(validateWorkflowPlan(plan), plan);
  assert.throws(() => validateWorkflowPlan({ ...plan, operations: [operation, operation] }));
  assert.throws(() => validateWorkflowPlan({ ...plan, checkpoint: { value: Number.NaN } }));
  assert.throws(() => validateWorkflowPlan({ ...plan, checkpoint: { value: 'a'.repeat(65537) } }));
  assert.throws(() => validateWorkflowPlan({ ...plan, checkpoint: { token: () => 'not JSON' } }));
  assert.throws(() =>
    validateWorkflowPlan({ ...plan, checkpoint: JSON.parse('{"__proto__":{}}') }),
  );
  let nested: unknown = {};
  for (let index = 0; index < 35; index++) nested = { nested };
  assert.throws(() => validateSchemaDocument(nested));
  assert.throws(() => validateWorkflowPlan({ ...plan, observations: [null] }));
  assert.throws(() =>
    validateWorkflowPlan({
      ...plan,
      observations: [
        {
          sourceId: 'source-1',
          kind: 'checksum',
          reason: 'Invented authority',
          evidenceIds: [],
          candidateIds: [],
        },
      ],
    }),
  );
  assert.throws(() =>
    validateWorkflowPlan({
      ...plan,
      proposals: [
        {
          sourceId: 'source-1',
          findingId: 'finding-1',
          action: 'delete-file',
          candidateId: 'candidate-1',
          evidenceIds: [],
          reason: 'Forbidden',
        },
      ],
    }),
  );
  const unusual: unknown[] = new Array(1);
  Object.assign(unusual, { extra: 'not represented by JSON' });
  assert.throws(() => validateWorkflowPlan({ ...plan, checkpoint: unusual }));
});

test('operation results distinguish accepted async work and never serialize credential fields', () => {
  assert.deepEqual(
    validateOperationResult({
      state: 'pending',
      resumeHandle: { jobId: 'external-1' },
      pollAfterMs: 1000,
    }),
    { state: 'pending', resumeHandle: { jobId: 'external-1' }, pollAfterMs: 1000 },
  );
  assert.throws(() =>
    validateOperationResult({
      state: 'pending',
      resumeHandle: { apiKey: 'generated-not-a-key' },
      pollAfterMs: 1000,
    }),
  );
  assert.throws(() =>
    validateOperationResult({ state: 'pending', resumeHandle: {}, pollAfterMs: -1 }),
  );
  assert.throws(() =>
    validateOperationResult({ state: 'completed', output: {}, usage: { inputTokens: -1 } }),
  );
  assert.throws(() =>
    validateOperationResult({
      state: 'completed',
      output: {},
      usage: { estimatedCostMicros: 0.5 },
    }),
  );
  assert.doesNotThrow(() =>
    validateOperationResult({
      state: 'completed',
      output: { observations: [] },
      usage: { inputTokens: 12, estimatedCostMicros: null, reportedCostMicros: 4, currency: 'USD' },
    }),
  );
});
