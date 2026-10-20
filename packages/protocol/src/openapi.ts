import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { HTTP_OPERATIONS } from './http-contract.js';

export interface JsonSchema {
  type?: string | string[];
  format?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  $ref?: string;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, { operationId?: string }>>;
  components: { schemas: Record<string, JsonSchema> };
}

export interface ContractSurface {
  paths: string[];
  schemas: Record<string, { properties: string[]; required: string[] }>;
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function openApiFile(): string {
  return join(packageRoot, 'openapi', 'openapi.yaml');
}

export function loadOpenApi(): OpenApiDocument {
  const document = parse(readFileSync(openApiFile(), 'utf8')) as OpenApiDocument;
  if (document.openapi !== '3.1.0') throw new Error('OpenAPI document must be 3.1.0');
  return document;
}

export function extractSurface(document: OpenApiDocument): ContractSurface {
  const paths: string[] = [];
  const operations = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const method of Object.keys(methods)) {
      if (!operations.has(method)) continue;
      paths.push(`${method.toUpperCase()} ${path.replaceAll(/\{([^}]+)\}/g, ':$1')}`);
    }
  }
  paths.sort();
  const schemas: ContractSurface['schemas'] = {};
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    schemas[name] = {
      properties: Object.keys(schema.properties ?? {}).sort(),
      required: [...(schema.required ?? [])].sort(),
    };
  }
  return { paths, schemas };
}

export function findBreakingChanges(baseline: ContractSurface, current: ContractSurface): string[] {
  const breaks: string[] = [];
  for (const path of baseline.paths) {
    if (!current.paths.includes(path)) breaks.push(`removed operation ${path}`);
  }
  for (const [name, schema] of Object.entries(baseline.schemas)) {
    const next = current.schemas[name];
    if (!next) {
      breaks.push(`removed schema ${name}`);
      continue;
    }
    for (const property of schema.properties) {
      if (!next.properties.includes(property)) breaks.push(`removed property ${name}.${property}`);
    }
    for (const required of next.required) {
      if (!schema.required.includes(required))
        breaks.push(`new required property ${name}.${required}`);
    }
  }
  return breaks;
}

export function missingContractOperations(document: OpenApiDocument): string[] {
  const surface = new Set(extractSurface(document).paths);
  return HTTP_OPERATIONS.filter((operation) => !surface.has(operation));
}
