export interface WindowSelection {
  source?: string;
  item?: string;
  asset?: string;
  profile: string;
  battery?: string;
  state?: string;
}
const fields = ['source', 'item', 'asset', 'profile', 'battery', 'state'] as const;
function validSelection(value: WindowSelection): WindowSelection {
  for (const key of fields) {
    const text = value[key];
    if (
      text !== undefined &&
      (typeof text !== 'string' ||
        !text.trim() ||
        text.length > 512 ||
        [...text].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
    )
      throw Error('Invalid game window selection');
  }
  if (
    !value.profile ||
    (value.source ? !!value.asset : !(value.item && value.asset)) ||
    ((value.battery || value.state) && !value.item)
  )
    throw Error('Invalid game window selection');
  return Object.fromEntries(
    fields.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
  ) as unknown as WindowSelection;
}
export function gameWindowUrl(origin: string, selection: WindowSelection): string {
  const base = new URL(origin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password)
    throw Error('Invalid game window origin');
  const url = new URL('/play/', base.origin);
  for (const [key, value] of Object.entries(validSelection(selection)))
    url.searchParams.set(key, value);
  url.searchParams.set('gameWindow', '1');
  return url.href;
}
export function readGameWindowSelection(query: URLSearchParams): WindowSelection | null {
  if (!query.has('gameWindow')) return null;
  if (
    query.get('gameWindow') !== '1' ||
    ['gameWindow', ...fields].some((k) => query.getAll(k).length > 1)
  )
    throw Error('Invalid game window selection');
  return validSelection(
    Object.fromEntries(
      fields.flatMap((key) => (query.has(key) ? [[key, query.get(key)]] : [])),
    ) as unknown as WindowSelection,
  );
}
export function validateWindowSaves(
  selection: WindowSelection,
  files: readonly { id: string; kind: string }[],
): void {
  validSelection(selection);
  if (
    selection.battery &&
    !files.some((f) => f.id === selection.battery && f.kind === 'battery_save')
  )
    throw Error('The selected battery save is no longer available for this target.');
  if (selection.state && !files.some((f) => f.id === selection.state && f.kind === 'save_state'))
    throw Error('The selected state is no longer available for this target.');
}
export interface GameWindowHandle {
  readonly closed: boolean;
  opener?: unknown;
}
/** Tracks only this launch. Never controls, focuses or closes the independent game. */
export class GameWindowLaunch {
  opened = false;
  error: string | null = null;
  private child: GameWindowHandle | null = null;
  open(url: string, openWindow: (url: string) => GameWindowHandle | null): boolean {
    if (this.opened) return false;
    this.error = null;
    try {
      const child = openWindow(url);
      if (!child) throw Error('Popup blocked. Allow a game window, or continue in this tab.');
      this.child = child;
      this.opened = true;
      try {
        child.opener = null;
      } catch {
        /* Isolation may already have severed the opener. */
      }
      return true;
    } catch {
      this.error = 'Popup blocked. Allow a game window, or continue in this tab.';
      return false;
    }
  }
  checkClosed(): void {
    if (!this.child) return;
    try {
      if (this.child.closed === true) {
        this.child = null;
        this.opened = false;
      }
    } catch {
      /* Uncertain ownership stays locked; no automatic takeover. */
    }
  }
  dispose(): void {
    this.child = null;
  }
}
