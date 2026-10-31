import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import { invalid, type JsonValue, jsonValue, WORKFLOW_LIMITS } from './values.js';

export type SchemaDocument = boolean | { [key: string]: JsonValue };
const validators = new WeakMap<object, ValidateFunction>();
const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  validateFormats: true,
  addUsedSchema: false,
});

export function validateSchemaDocument(value: unknown): SchemaDocument {
  jsonValue(value, WORKFLOW_LIMITS.schema);
  if (typeof value !== 'boolean' && (!value || typeof value !== 'object' || Array.isArray(value)))
    invalid('Invalid workflow schema');
  function references(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    for (const [key, item] of Object.entries(node)) {
      if (
        ['$ref', '$dynamicRef'].includes(key) &&
        (typeof item !== 'string' || !item.startsWith('#'))
      )
        invalid('External workflow schema references are forbidden');
      if (key === '$async') invalid('Async workflow schemas are forbidden');
      references(item);
    }
  }
  references(value);
  const schema = structuredClone(value) as SchemaDocument;
  let compiled: ValidateFunction;
  try {
    compiled = ajv.compile(schema);
  } catch {
    return invalid('Invalid or unsupported workflow schema');
  }
  if (typeof schema === 'object') {
    function freeze(item: JsonValue): void {
      if (!item || typeof item !== 'object') return;
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    freeze(schema);
    validators.set(schema, compiled);
  }
  return schema;
}

export function validateSchemaValue(schema: SchemaDocument, value: unknown): void {
  jsonValue(value);
  const validate = typeof schema === 'object' ? validators.get(schema) : undefined;
  const compiled = validate ?? ajv.compile(validateSchemaDocument(schema));
  if (!compiled(value)) invalid('Value does not match the workflow schema');
}
