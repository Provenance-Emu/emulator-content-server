import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  fixture,
  type ProcessHandle,
  probeRunner,
  QUOTA,
  type Runner,
  synthetic,
  track,
} from './chd-fixture.js';

function decoder(
  action: (args: readonly string[], cwd: string) => Promise<void>,
  hooks?: { kills?: string[]; delay?: number; neverExit?: boolean },
): Runner {
  return (exe, args, options) => {
    if (args[0] === 'help') return probeRunner(exe, args, options);
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(isAbsolute(exe), true);
    assert.equal(isAbsolute(options.cwd), true);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let finish: (result: { code: number | null; signal?: string | null }) => void = () => {};
    const exited: ProcessHandle['exited'] = new Promise((resolve) => {
      finish = resolve;
    });
    const complete = (code: number | null, signal?: string) => {
      stdout.end();
      stderr.end();
      finish({ code, ...(signal ? { signal } : {}) });
    };
    void (async () => {
      try {
        await action(args, options.cwd);
        if (!hooks?.neverExit) setTimeout(() => complete(0), hooks?.delay ?? 0);
      } catch {
        complete(1);
      }
    })();
    return {
      stdout,
      stderr,
      exited,
      kill(signal) {
        hooks?.kills?.push(signal);
        if (signal === 'SIGKILL' || !hooks?.neverExit) complete(null, signal);
      },
    };
  };
}
const dvdOutput = async (args: readonly string[], cwd: string) => {
  assert.deepEqual(args.slice(0, 2), ['extractdvd', '-i']);
  assert.equal(args[2]?.endsWith('source'), true);
  assert.deepEqual(args.slice(3), ['-o', join(cwd, 'disc.iso')]);
  await writeFile(join(cwd, 'disc.iso'), Buffer.alloc(4096, 7));
};

test('DVD decoder emits immutable fixed-name arguments and returns verified hash and exact size', async () => {
  const f = await fixture(synthetic(), decoder(dvdOutput));
  try {
    const destination = join(f.root, 'output');
    await mkdir(destination);
    const bundle = await f.provider.materializeBundle?.(f.path, 'disc', destination, QUOTA);
    assert.equal(bundle?.version, 'chd-v1');
    assert.deepEqual(
      bundle?.files.map((e) => [e.entryId, e.path, e.size]),
      [['0', 'disc.iso', 4096]],
    );
    assert.equal(
      bundle?.files[0]?.sha256,
      'c9ac7b0624824f844f6c7f3d50fab9741a8914e878467e8daaedca143a34d90b',
    );
  } finally {
    await f.cleanup();
  }
});

test('CD decoder verifies tool descriptor, canonicalizes it and returns both files', async () => {
  const cue =
    'FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:00:01\n';
  const f = await fixture(
    synthetic([track(1, 'MODE1', 1), track(2, 'AUDIO', 1)], false),
    decoder(async (args, cwd) => {
      assert.deepEqual(args.slice(0, 2), ['extractcd', '-i']);
      assert.deepEqual(args.slice(3), ['-o', join(cwd, 'tool.cue'), '-ob', join(cwd, 'disc.bin')]);
      await writeFile(join(cwd, 'disc.bin'), Buffer.alloc(4400, 8));
      await writeFile(join(cwd, 'tool.cue'), cue.replaceAll('\n', '\r\n'));
    }),
  );
  try {
    const output = join(f.root, 'out');
    await mkdir(output);
    const bundle = await f.provider.materializeBundle?.(f.path, 'disc', output, QUOTA);
    assert.equal(bundle?.files.length, 2);
    assert.equal(await readFile(join(output, 'disc.cue'), 'utf8'), cue);
    assert.deepEqual((await readdir(output)).sort(), ['disc.bin', 'disc.cue']);
  } finally {
    await f.cleanup();
  }
});
for (const mode of ['wrong-size', 'symlink', 'side-file', 'nonzero', 'spawn'] as const) {
  test(`decoder rejects ${mode} and removes every staged output`, async () => {
    const run = decoder(async (_args, cwd) => {
      if (mode === 'spawn' || mode === 'nonzero') throw new Error('secret native host path');
      if (mode === 'symlink') await symlink(join(cwd, '..', 'source'), join(cwd, 'disc.iso'));
      else
        await writeFile(join(cwd, 'disc.iso'), Buffer.alloc(mode === 'wrong-size' ? 4095 : 4096));
      if (mode === 'side-file') await writeFile(join(cwd, 'side'), 'x');
    });
    const f = await fixture(
      synthetic(),
      mode === 'spawn'
        ? (exe, args, options) => {
            if (args[0] !== 'help') throw new Error('sensitive');
            return run(exe, args, options);
          }
        : run,
    );
    try {
      const output = join(f.root, 'out');
      await mkdir(output);
      await assert.rejects(
        f.provider.materializeBundle?.(f.path, 'disc', output, QUOTA) ?? Promise.resolve(),
        (error) => !String(error).includes('sensitive'),
      );
      assert.deepEqual(await readdir(output), []);
      assert.equal(
        (await readdir(f.root)).some((n) => n.includes('.partial')),
        false,
      );
    } finally {
      await f.cleanup();
    }
  });
}

test('decoder kills an overrun, escalates cancellation and awaits process exit before cleanup', async () => {
  const kills: string[] = [];
  const f = await fixture(
    synthetic(),
    decoder(
      async (_args, cwd) => {
        await writeFile(join(cwd, 'side'), Buffer.alloc(10000));
      },
      { neverExit: true, kills },
    ),
  );
  try {
    const output = join(f.root, 'out');
    await mkdir(output);
    await assert.rejects(
      f.provider.materializeBundle?.(f.path, 'disc', output, QUOTA) ?? Promise.resolve(),
      /quota|output/i,
    );
    assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(await readdir(output), []);
  } finally {
    await f.cleanup();
  }
});
for (const mode of ['deadline', 'abort', 'close'] as const) {
  test(`${mode} cancels and joins the active process`, async () => {
    const kills: string[] = [];
    let start: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      start = resolve;
    });
    const f = await fixture(
      synthetic(),
      decoder(
        async () => {
          start();
        },
        { neverExit: true, kills },
      ),
    );
    try {
      const output = join(f.root, 'out');
      await mkdir(output);
      const controller = new AbortController();
      const pending =
        f.provider.materializeBundle?.(
          f.path,
          'disc',
          output,
          { ...QUOTA, timeoutMs: 1000 },
          controller.signal,
        ) ?? Promise.resolve();
      const assertion = assert.rejects(pending);
      await started;
      if (mode === 'abort') controller.abort();
      if (mode === 'close') await f.provider.close?.();
      await assertion;
      assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
      assert.deepEqual(await readdir(output), []);
    } finally {
      await f.cleanup();
    }
  });
}

test('CD descriptor cannot redirect references, hide tracks or change indexes', async () => {
  for (const text of [
    'FILE "../../host" BINARY\n',
    'FILE "disc.bin" BINARY\n  TRACK 01 AUDIO\n    INDEX 01 00:00:01\n',
  ]) {
    const f = await fixture(
      synthetic([track(1, 'AUDIO', 1)], false),
      decoder(async (_args, cwd) => {
        await writeFile(join(cwd, 'disc.bin'), Buffer.alloc(2352));
        await writeFile(join(cwd, 'tool.cue'), text);
      }),
    );
    try {
      const out = join(f.root, 'out');
      await mkdir(out);
      await assert.rejects(
        f.provider.materializeBundle?.(f.path, 'disc', out, QUOTA) ?? Promise.resolve(),
      );
      assert.deepEqual(await readdir(out), []);
    } finally {
      await f.cleanup();
    }
  }
});

test('startup rejects relative, missing and incompatible configured decoders', async () => {
  const f = await fixture(synthetic());
  try {
    const { factory } = await import('./chd-fixture.js');
    const create = await factory();
    await assert.rejects(create('chdman'), /absolute|config/i);
    await assert.rejects(create(join(f.root, 'missing')), /config|executable/i);
    await assert.rejects(
      create(join(f.root, 'decoder'), {
        runner: () => {
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          stdout.end('old tool');
          stderr.end();
          return { stdout, stderr, exited: Promise.resolve({ code: 0 }), kill() {} };
        },
      }),
      /config|support/i,
    );
  } finally {
    await f.cleanup();
  }
});

test('decoder isolates its random private working directory from the requested destination', async () => {
  const f = await fixture(
    synthetic(),
    decoder(async (args, cwd) => {
      assert.match(cwd, /\.partial-/);
      await dvdOutput(args, cwd);
    }),
  );
  try {
    const out = join(f.root, 'out');
    await mkdir(out);
    const bundle = await f.provider.materializeBundle?.(f.path, 'disc', out, QUOTA);
    assert.equal(bundle?.files[0]?.size, 4096);
    assert.deepEqual(await readdir(out), ['disc.iso']);
  } finally {
    await f.cleanup();
  }
});

test('a rejected reservation cannot release another active job storage reservation', async () => {
  const f = await fixture(synthetic(), decoder(dvdOutput, { delay: 70 }));
  try {
    const destinations = await Promise.all(
      ['a', 'b', 'c'].map(async (name) => {
        const path = join(f.root, name);
        await mkdir(path);
        return path;
      }),
    );
    const quota = { ...QUOTA, maxExpandedBytes: 4096 };
    const first = f.provider.materializeBundle?.(f.path, 'disc', destinations[0] ?? '', quota);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(
      f.provider.materializeBundle?.(f.path, 'disc', destinations[1] ?? '', quota) ??
        Promise.resolve(),
      /in-flight/i,
    );
    await assert.rejects(
      f.provider.materializeBundle?.(f.path, 'disc', destinations[2] ?? '', quota) ??
        Promise.resolve(),
      /in-flight/i,
    );
    await first;
  } finally {
    await f.cleanup();
  }
});

test('one active decoder admits eight queued jobs, then rejects the ninth and releases the queue on shutdown', async () => {
  const kills: string[] = [];
  let launches = 0;
  const base = decoder(
    async () => {
      launches += 1;
    },
    { neverExit: true, kills },
  );
  const f = await fixture(synthetic(), base);
  try {
    const outputs = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const out = join(f.root, String(i));
        await mkdir(out);
        return out;
      }),
    );
    const pending: Promise<unknown>[] = [];
    for (let i = 0; i < 9; i += 1) {
      pending.push(
        (
          f.provider.materializeBundle?.(f.path, 'disc', outputs[i] ?? '', QUOTA) ??
          Promise.resolve()
        ).catch((error) => error),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(
      f.provider.materializeBundle?.(f.path, 'disc', outputs[9] ?? '', QUOTA) ?? Promise.resolve(),
      /queue/i,
    );
    await f.provider.close?.();
    await Promise.all(pending);
    assert.equal(launches, 1);
    assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
  } finally {
    await f.cleanup();
  }
});

test('decoder bounds logs and never exposes stderr from a native failure', async () => {
  const f = await fixture(synthetic(), (exe, args, options) => {
    if (args[0] === 'help') return probeRunner(exe, args, options);
    const child = decoder(async () => {}, { neverExit: true })(exe, args, options);
    setTimeout(() => child.stderr.write('HOST_SECRET'.repeat(10000)), 5);
    return child;
  });
  try {
    const out = join(f.root, 'out');
    await mkdir(out);
    await assert.rejects(
      f.provider.materializeBundle?.(f.path, 'disc', out, QUOTA) ?? Promise.resolve(),
      (error) => /log budget/i.test(String(error)) && !String(error).includes('HOST_SECRET'),
    );
    assert.deepEqual(await readdir(out), []);
  } finally {
    await f.cleanup();
  }
});

test('a fast exiting decoder cannot bypass the descriptor memory or aggregate staging budget', async () => {
  const f = await fixture(
    synthetic([track(1, 'AUDIO', 1)], false),
    (exe, args, options) => {
      if (args[0] === 'help') return probeRunner(exe, args, options);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      return {
        stdout,
        stderr,
        exited: new Promise((resolve) => {
          setTimeout(() => {
            writeFileSync(join(options.cwd, 'disc.bin'), Buffer.alloc(2352));
            writeFileSync(join(options.cwd, 'tool.cue'), Buffer.alloc(2_000_000));
            stdout.end();
            stderr.end();
            resolve({ code: 0 });
          }, 30);
        }),
        kill() {},
      };
    },
    { pollIntervalMs: 100 },
  );
  try {
    const out = join(f.root, 'out');
    await mkdir(out);
    await assert.rejects(
      f.provider.materializeBundle?.(f.path, 'disc', out, QUOTA) ?? Promise.resolve(),
      /quota|descriptor.*large/i,
    );
    assert.deepEqual(await readdir(out), []);
  } finally {
    await f.cleanup();
  }
});

test('a preexisting destination is rejected without deleting caller files', async () => {
  const f = await fixture(synthetic(), decoder(dvdOutput));
  try {
    const out = join(f.root, 'out');
    await mkdir(out);
    await writeFile(join(out, 'keep'), 'keep');
    await assert.rejects(
      f.provider.materializeBundle?.(f.path, 'disc', out, QUOTA) ?? Promise.resolve(),
      /empty/i,
    );
    assert.equal(await readFile(join(out, 'keep'), 'utf8'), 'keep');
  } finally {
    await f.cleanup();
  }
});

test('a queued job spends its original deadline before spawning rather than starting a fresh timeout', async () => {
  let starts = 0;
  let start: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const f = await fixture(
    synthetic(),
    decoder(
      async (args, cwd) => {
        starts += 1;
        start();
        await dvdOutput(args, cwd);
      },
      { delay: 200 },
    ),
  );
  try {
    const a = join(f.root, 'a');
    const b = join(f.root, 'b');
    await mkdir(a);
    await mkdir(b);
    const first = f.provider.materializeBundle?.(f.path, 'disc', a, QUOTA);
    await started;
    await assert.rejects(
      f.provider.materializeBundle?.(f.path, 'disc', b, { ...QUOTA, timeoutMs: 40 }) ??
        Promise.resolve(),
      /timed out/i,
    );
    await first;
    assert.equal(starts, 1);
    assert.deepEqual(await readdir(b), []);
  } finally {
    await f.cleanup();
  }
});

test('mixed tracks retain frame-relative indexes and mode-specific bytes without CHD padding', async () => {
  const cue =
    'FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    INDEX 01 00:01:01\n  TRACK 03 MODE2/2352\n    INDEX 01 00:02:01\n';
  const f = await fixture(
    synthetic([track(1, 'MODE1', 76), track(2, 'AUDIO', 75), track(3, 'MODE2_RAW', 1)], false),
    decoder(async (_args, cwd) => {
      await writeFile(join(cwd, 'tool.cue'), cue);
      await writeFile(
        join(cwd, 'disc.bin'),
        Buffer.concat([Buffer.alloc(155648, 1), Buffer.alloc(176400, 2), Buffer.alloc(2352, 3)]),
      );
    }),
  );
  try {
    const out = join(f.root, 'out');
    await mkdir(out);
    const group = await f.provider.materializeBundle?.(f.path, 'disc', out, QUOTA);
    assert.equal(group?.files[0]?.size, 150);
    assert.equal(group?.files[1]?.size, 334400);
    assert.equal(await readFile(join(out, 'disc.cue'), 'utf8'), cue);
    const bin = await readFile(join(out, 'disc.bin'));
    assert.deepEqual(bin.subarray(155646, 155650), Buffer.from([1, 1, 2, 2]));
    assert.deepEqual(bin.subarray(332046, 332050), Buffer.from([2, 2, 3, 3]));
  } finally {
    await f.cleanup();
  }
});

test('MODE1_RAW retains 2352-byte sectors and MODE1/2352 descriptor semantics', async () => {
  const cue = 'FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n';
  const f = await fixture(
    synthetic([track(1, 'MODE1_RAW', 1)], false),
    decoder(async (_args, cwd) => {
      await writeFile(join(cwd, 'tool.cue'), cue);
      await writeFile(join(cwd, 'disc.bin'), Buffer.alloc(2352, 42));
    }),
  );
  try {
    const out = join(f.root, 'out');
    await mkdir(out);
    const group = await f.provider.materializeBundle?.(f.path, 'disc', out, QUOTA);
    assert.equal(group?.files[1]?.size, 2352);
    assert.equal(await readFile(join(out, 'disc.cue'), 'utf8'), cue);
  } finally {
    await f.cleanup();
  }
});
