/** There are no request IDs in this ABI. One channel owns every command. */
export type RuntimeCommand = 'SAVE_FILES' | 'SAVE_STATE_SLOT 0' | 'LOAD_STATE_SLOT 0';
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
    const result = this.tail.then(() => this.perform(command));
    this.tail = result.catch(() => {});
    return result;
  }

  private async perform(command: RuntimeCommand): Promise<void> {
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
          if (typeof raw !== 'string') throw new Error('Invalid core reply');
          const reply = raw.replace(/[\r\n]+$/, '');
          if (
            reply === (command === 'SAVE_FILES' ? 'OK' : command) ||
            (command === 'LOAD_STATE_SLOT 0' && reply === 'LOAD_STATE_SLOT 0, queue ended')
          )
            return;
          // Diagnostics are untrusted human text, never another success grammar.
          throw new Error(
            'Core rejected the command or returned an unexpected reply. Reload this document.',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.pollMs));
      }
    } catch (error) {
      // A late response could otherwise be mistaken for a retry, including anonymous OK.
      this.quarantined = true;
      throw error;
    }
  }
}
