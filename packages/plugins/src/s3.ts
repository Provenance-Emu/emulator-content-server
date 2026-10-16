import { createHash, createHmac } from 'node:crypto';
import { PluginError } from './errors.js';

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface S3SignInput {
  method: 'GET';
  host: string;
  path: string;
  query: Record<string, string>;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  range?: string;
  now: Date;
}

export interface SignedRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** AWS Signature Version 4 for a GET. The payload is empty, which object reads are. */
export function signS3(input: S3SignInput): SignedRequest {
  const { amz, day } = amzDate(input.now);
  const payloadHash = EMPTY_SHA256;
  const headers: Record<string, string> = {
    host: input.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amz,
  };
  if (input.range !== undefined) headers.range = input.range;
  if (input.sessionToken !== undefined) headers['x-amz-security-token'] = input.sessionToken;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}`).join('\n');
  const signedHeaders = names.join(';');
  const canonicalQuery = canonicalizeQuery(input.query);
  const canonical = [
    input.method,
    input.path,
    canonicalQuery,
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(input.secretAccessKey, day, input.region))
    .update(stringToSign)
    .digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const query = canonicalQuery === '' ? '' : `?${canonicalQuery}`;
  return {
    method: 'GET',
    url: `https://${input.host}${input.path}${query}`,
    headers: { ...headers, authorization },
  };
}

export function s3Host(
  bucket: string,
  region: string,
  endpoint?: string,
): { host: string; basePath: string } {
  if (endpoint === undefined) {
    const host =
      region === 'us-east-1'
        ? `${bucket}.s3.amazonaws.com`
        : `${bucket}.s3.${region}.amazonaws.com`;
    return { host, basePath: '' };
  }
  const url = new URL(endpoint);
  return { host: url.host, basePath: `/${bucket}` };
}

export function encodeKey(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

export interface S3Object {
  key: string;
  size: number;
}

export function parseS3List(xml: string): {
  objects: S3Object[];
  truncated: boolean;
  token: string | null;
} {
  if (!xml.includes('<ListBucketResult')) {
    throw new PluginError('cloud-response', 'S3 list was not a bucket listing');
  }
  const objects: S3Object[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1] ?? '';
    const key = decodeXml(textBetween(block, 'Key'));
    const size = Number(textBetween(block, 'Size'));
    if (key === null || !Number.isInteger(size) || size < 0) {
      throw new PluginError('cloud-response', 'S3 list has an entry without a key and size');
    }
    objects.push({ key, size });
  }
  const truncated = textBetween(xml, 'IsTruncated') === 'true';
  const token = textBetween(xml, 'NextContinuationToken');
  if (truncated && token === null) {
    throw new PluginError('cloud-response', 'S3 list is truncated without a continuation token');
  }
  return { objects, truncated, token };
}

function signingKey(secret: string, day: string, region: string): Buffer {
  const date = hmac(`AWS4${secret}`, day);
  const regional = hmac(date, region);
  const service = hmac(regional, 's3');
  return hmac(service, 'aws4_request');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function amzDate(date: Date): { amz: string; day: string } {
  const amz = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { amz, day: amz.slice(0, 8) };
}

function canonicalizeQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => {
    const hex = char.charCodeAt(0).toString(16).toUpperCase();
    return `%${hex}`;
  });
}

function textBetween(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match?.[1] ?? null;
}

function decodeXml(value: string | null): string | null {
  if (value === null) return null;
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}
