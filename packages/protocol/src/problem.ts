export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: Record<string, string>;
}

export function problemType(code: string): string {
  return `urn:ecs:problem:${code}`;
}

export function problem(input: {
  code: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: Record<string, string>;
}): Problem {
  const body: Problem = {
    type: problemType(input.code),
    title: input.title,
    status: input.status,
  };
  if (input.detail !== undefined) body.detail = input.detail;
  if (input.instance !== undefined) body.instance = input.instance;
  if (input.requestId !== undefined) body.requestId = input.requestId;
  if (input.errors !== undefined) body.errors = input.errors;
  return body;
}
