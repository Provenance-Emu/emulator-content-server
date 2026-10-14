import { assertClaims } from './claims.js';
import { PluginError } from './errors.js';

export interface ToolPlan {
  /** Never spawned by this package. The host prints the plan and stops. */
  spawn: false;
  steps: string[][];
}

/**
 * The certificate password is not a parameter. zsign's `-p` would put it in
 * the process list, so a plan that needs a password is not a plan we emit.
 */
export function planZsign(input: {
  ipa: string;
  output: string;
  certificate: string;
  profile: string;
  bundleId: string;
  apps: readonly string[];
}): ToolPlan {
  assertClaims(input.apps, input.bundleId);
  const argv = [
    'zsign',
    '-k',
    input.certificate,
    '-m',
    input.profile,
    '-o',
    input.output,
    '-b',
    input.bundleId,
    input.ipa,
  ];
  if (argv.includes('-p') || argv.includes('--password')) {
    throw new PluginError('secret-on-command-line', 'zsign must not receive a password argument');
  }
  return { spawn: false, steps: [argv] };
}

/**
 * JIT here is a debugger attach. The plan names the tool and the bundle. It
 * does not launch the tool, patch a process, or inject into one.
 */
export function planJit(input: { bundleId: string; apps: readonly string[] }): ToolPlan {
  assertClaims(input.apps, input.bundleId);
  return {
    spawn: false,
    steps: [
      ['pymobiledevice3', 'mounter', 'auto-mount'],
      ['pymobiledevice3', 'developer', 'dvt', 'launch', input.bundleId, '--detach'],
      ['pymobiledevice3', 'developer', 'debugserver', 'start-server'],
    ],
  };
}
