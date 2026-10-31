interface PresentationInput {
  presentationBusy: boolean;
  releaseAll(): void;
}
/** Own modal leases synchronously, before awaiting any input RPC. */
export class PresentationGate {
  private owners = new Set<string>();
  private previous = false;
  constructor(
    private input: () => PresentationInput | null,
    private otherwiseBusy: () => boolean = () => false,
  ) {}
  has(owner: string): boolean {
    return this.owners.has(owner);
  }
  acquire(owner: string): boolean {
    if (this.has(owner)) return false;
    const input = this.input();
    if (!this.owners.size) this.previous = input?.presentationBusy ?? false;
    this.owners.add(owner);
    if (input) {
      input.presentationBusy = true;
      input.releaseAll();
    }
    return true;
  }
  release(owner: string): void {
    if (!this.owners.delete(owner)) return;
    const input = this.input();
    if (input) {
      input.presentationBusy = this.owners.size > 0 || this.previous || this.otherwiseBusy();
      input.releaseAll();
    }
  }
  dispose(): void {
    for (const owner of [...this.owners]) this.release(owner);
  }
}
