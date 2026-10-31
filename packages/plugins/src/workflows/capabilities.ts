import { integer, invalid, jsonValue, list, object, text } from './values.js';

export interface CapabilityBinding {
  capability: string;
  major: number;
  requires?: Record<string, boolean>;
  optional?: boolean;
}

export interface CapabilityDescription {
  capability: string;
  major: number;
  features: Record<string, boolean>;
  inputMediaTypes: string[];
  maxInputBytes: number;
  maxOutputBytes: number;
  asynchronous: boolean;
  cancellation: boolean;
}

export function capabilityName(value: unknown): string {
  const name = text(value, 120);
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(name))
    invalid('Invalid capability identifier');
  return name;
}

export function parseCapabilityBinding(value: unknown): CapabilityBinding {
  const record = object(value, ['capability', 'major', 'requires', 'optional']);
  const binding: CapabilityBinding = {
    capability: capabilityName(record.capability),
    major: integer(record.major, 1, 1000),
  };
  if (record.optional !== undefined) {
    if (typeof record.optional !== 'boolean') invalid('Invalid optional binding');
    binding.optional = record.optional;
  }
  if (record.requires !== undefined) {
    const requirements = object(record.requires);
    if (Object.keys(requirements).length > 32) invalid('Too many capability requirements');
    for (const [name, required] of Object.entries(requirements)) {
      if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(name) || typeof required !== 'boolean')
        invalid('Invalid capability requirement');
    }
    binding.requires = requirements as Record<string, boolean>;
  }
  return binding;
}

export function validateCapabilityBinding(
  required: CapabilityBinding,
  offered: CapabilityDescription,
): void {
  const checked = parseCapabilityBinding(required);
  validateCapabilityDescription(offered);
  if (
    checked.capability !== offered.capability ||
    checked.major !== offered.major ||
    Object.entries(checked.requires ?? {}).some(([key, value]) => offered.features[key] !== value)
  ) {
    throw new Error('Configured backend does not support the required capability');
  }
  integer(offered.maxInputBytes, 1);
  integer(offered.maxOutputBytes, 1);
}

export function validateCapabilityDescription(value: unknown): CapabilityDescription {
  jsonValue(value, 64 * 1024, true);
  const record = object(value, [
    'capability',
    'major',
    'features',
    'inputMediaTypes',
    'maxInputBytes',
    'maxOutputBytes',
    'asynchronous',
    'cancellation',
  ]);
  capabilityName(record.capability);
  integer(record.major, 1, 1000);
  const features = object(record.features);
  if (
    Object.keys(features).length > 32 ||
    Object.values(features).some((feature) => typeof feature !== 'boolean')
  )
    invalid('Capability features must be booleans');
  for (const type of list(record.inputMediaTypes, 32)) {
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(text(type, 120)))
      invalid('Invalid capability media type');
  }
  integer(record.maxInputBytes, 1);
  integer(record.maxOutputBytes, 1);
  if (typeof record.asynchronous !== 'boolean' || typeof record.cancellation !== 'boolean')
    invalid('Invalid capability lifecycle');
  return value as CapabilityDescription;
}
