/** There are no request IDs in this ABI. One channel owns every command. */
import {
  type CoreOption,
  containsControls,
  parseOptions,
  validOptionKey,
  validOptionValue,
} from './options.js';
export type RuntimeCommand = 'SAVE_FILES' | 'SAVE_STATE_SLOT 0' | 'LOAD_STATE_SLOT 0';
export class CoreOptionRejected extends Error {}
export interface CommandRuntime {
  EmscriptenSendCommand(command: string): void | Promise<void>;
  EmscriptenReceiveCommandReply(): string | undefined | Promise<string | undefined>;
}
export class CommandChannel {
  private tail: Promise<void> = Promise.resolve();
  private drained = false;
  private quarantined = false;

  constructor(
    private readonly runtime: CommandRuntime,
    private readonly options = { deadlineMs: 30_000, pollMs: 20 },
  ) {
    if (
      typeof runtime.EmscriptenSendCommand !== 'function' ||
      typeof runtime.EmscriptenReceiveCommandReply !== 'function'
    ) {
      throw new Error(
        'Unsupported core: direct JavaScript command/reply helpers are required. Reload after setup.',
      );
    }
    if (!(options.deadlineMs > 0 && options.deadlineMs <= 30_000 && options.pollMs > 0)) {
      throw new Error('Invalid command deadline');
    }
  }

  run(command: RuntimeCommand): Promise<void> {
    return this.enqueue(() =>
      this.perform(command, (reply) => {
        if (
          reply === (command === 'SAVE_FILES' ? 'OK' : command) ||
          (command === 'LOAD_STATE_SLOT 0' && reply === 'LOAD_STATE_SLOT 0, queue ended')
        )
          return;
        throw new Error(
          'Core rejected the command or returned an unexpected reply. Reload this document.',
        );
      }),
    );
  }

  listOptions(): Promise<CoreOption[]> {
    return this.enqueue(() => this.perform('GET_CORE_OPTION', (reply) => parseOptions(reply)));
  }
  option(key: string): Promise<CoreOption> {
    if (!validOptionKey(key)) return Promise.reject(new Error('Invalid core option key'));
    return this.enqueue(() => this.detail(key));
  }
  setOption(key: string, value: string): Promise<CoreOption> {
    if (!validOptionKey(key) || !validOptionValue(value))
      return Promise.reject(new Error('Invalid core option value'));
    return this.enqueue(async () => {
      const option = await this.detail(key);
      if (!option.values?.includes(value))
        throw new CoreOptionRejected('This core option does not accept that value');
      return this.perform(`SET_CORE_OPTION ${key} ${value}`, (reply) => {
        const applied = parseOptions(reply, key, false)[0];
        if (!applied || applied.value !== value)
          throw new Error('Core option write returned an unexpected reply');
        return { ...applied, values: option.values };
      });
    });
  }
  private detail(key: string): Promise<CoreOption> {
    return this.perform(`GET_CORE_OPTION ${key}`, (reply) => {
      const option = parseOptions(reply, key)[0];
      if (!option) throw new Error('Missing core option reply');
      return option;
    });
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  private async perform<T>(command: string, decode: (reply: string) => T): Promise<T> {
    if (this.quarantined) throw new Error('Command channel is quarantined. Reload this document.');
    try {
      if (!this.drained) {
        // Startup diagnostics cannot acknowledge a later request; bound even a broken producer.
        let count = 0;
        while ((await this.runtime.EmscriptenReceiveCommandReply()) !== undefined) {
          if (++count > 1024) throw new Error('Core startup reply queue did not drain');
        }
        this.drained = true;
      }
      await this.runtime.EmscriptenSendCommand(command);
      const deadline = Date.now() + this.options.deadlineMs;
      for (;;) {
        if (Date.now() >= deadline)
          throw new Error('Core command timed out. Reload this document.');
        const raw = await this.runtime.EmscriptenReceiveCommandReply();
        if (raw !== undefined) {
          if (typeof raw !== 'string' || raw.length > 60000) throw new Error('Invalid core reply');
          const reply = raw.replace(/[\r\n]+$/, '');
          const family = command.split(' ')[0];
          if (
            (family === 'GET_CORE_OPTION' || family === 'SET_CORE_OPTION') &&
            reply.startsWith(`${family} ERROR `) &&
            !containsControls(reply)
          )
            throw new CoreOptionRejected(reply.slice(family.length + 7));
          return decode(reply);
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.pollMs));
      }
    } catch (error) {
      if (error instanceof CoreOptionRejected) throw error;
      // A late response could otherwise be mistaken for a retry, including anonymous OK.
      this.quarantined = true;
      throw error;
    }
  }
}
