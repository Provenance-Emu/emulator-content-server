import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..', '..', '..');
const document = parse(readFileSync(join(scriptDir, '..', 'openapi', 'openapi.yaml'), 'utf8'));
const schemas = document.components.schemas;
const check = process.argv.includes('--check');

const tsTarget = join(repoRoot, 'packages', 'client-ts', 'src', 'generated.ts');
const swiftTarget = join(
  repoRoot,
  'clients',
  'swift',
  'Sources',
  'EmulatorContentClient',
  'GeneratedModels.swift',
);

const tsOutput = renderTypeScript(schemas);
const swiftOutput = renderSwift(schemas);
if (check) {
  assertSame(tsTarget, tsOutput);
  assertSame(swiftTarget, swiftOutput);
  console.log('generated clients match the OpenAPI document');
} else {
  mkdirSync(dirname(tsTarget), { recursive: true });
  mkdirSync(dirname(swiftTarget), { recursive: true });
  writeFileSync(tsTarget, tsOutput);
  writeFileSync(swiftTarget, swiftOutput);
  console.log(`wrote ${relative(repoRoot, tsTarget)} and ${relative(repoRoot, swiftTarget)}`);
}

function renderTypeScript(schemaMap) {
  const blocks = ['// Generated from packages/protocol/openapi/openapi.yaml. Do not edit.', ''];
  for (const [name, schema] of Object.entries(schemaMap)) {
    if (!isObject(schema)) continue;
    const required = new Set(schema.required ?? []);
    blocks.push(`export interface ${name} {`);
    for (const [property, definition] of Object.entries(schema.properties ?? {})) {
      const optional = required.has(property) ? '' : '?';
      blocks.push(`  ${property}${optional}: ${tsType(definition)};`);
    }
    blocks.push('}', '');
  }
  return `${blocks.join('\n').trim()}\n`;
}

function renderSwift(schemaMap) {
  const blocks = [
    '// Generated from packages/protocol/openapi/openapi.yaml. Do not edit.',
    '',
    'import Foundation',
    '',
  ];
  for (const [name, schema] of Object.entries(schemaMap)) {
    if (!isObject(schema)) continue;
    const required = new Set(schema.required ?? []);
    const properties = Object.entries(schema.properties ?? {});
    blocks.push(`public struct ${name}: Codable, Equatable, Sendable {`);
    for (const [property, definition] of properties) {
      blocks.push(
        `    public var ${safeSwift(property)}: ${swiftType(definition, required.has(property))}`,
      );
    }
    blocks.push('');
    const args = properties
      .map(([property, definition]) => {
        const type = swiftType(definition, required.has(property));
        const defaultValue = type.endsWith('?') ? ' = nil' : '';
        return `${safeSwift(property)}: ${type}${defaultValue}`;
      })
      .join(', ');
    blocks.push(`    public init(${args}) {`);
    for (const [property] of properties) {
      const swiftName = safeSwift(property);
      blocks.push(`        self.${swiftName} = ${swiftName}`);
    }
    blocks.push('    }');
    blocks.push('}', '');
  }
  return `${blocks.join('\n').trim()}\n`;
}

function isObject(schema) {
  return schema?.type === 'object' && schema.properties;
}

function tsType(schema) {
  if (schema.$ref) return refName(schema.$ref);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = types.includes('null');
  const concrete = types.find((type) => type !== 'null');
  let rendered = 'unknown';
  if (concrete === 'string') rendered = 'string';
  else if (concrete === 'integer' || concrete === 'number') rendered = 'number';
  else if (concrete === 'boolean') rendered = 'boolean';
  else if (concrete === 'array') rendered = `${tsType(schema.items ?? {})}[]`;
  else if (concrete === 'object') rendered = 'Record<string, unknown>';
  return nullable ? `${rendered} | null` : rendered;
}

function swiftType(schema, required) {
  if (schema.$ref) return maybeOptional(refName(schema.$ref), required, false);
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = types.includes('null');
  const concrete = types.find((type) => type !== 'null');
  let rendered = 'String';
  if (concrete === 'string') rendered = 'String';
  else if (concrete === 'integer' || concrete === 'number') {
    rendered = schema.format === 'int64' ? 'Int64' : 'Int';
  } else if (concrete === 'boolean') rendered = 'Bool';
  else if (concrete === 'array')
    rendered = `[${swiftType(schema.items ?? {}, true).replace(/\?$/, '')}]`;
  else if (concrete === 'object') rendered = '[String: String]';
  return maybeOptional(rendered, required, nullable);
}

function maybeOptional(type, required, nullable) {
  if (!required || nullable) return `${type}?`;
  return type;
}

function refName(ref) {
  return ref.split('/').at(-1);
}

function safeSwift(name) {
  return name === 'protocol' ? '`protocol`' : name;
}

function assertSame(file, expected) {
  const actual = readFileSync(file, 'utf8');
  if (actual !== expected) {
    throw new Error(`${file} does not match the OpenAPI generator output`);
  }
}
