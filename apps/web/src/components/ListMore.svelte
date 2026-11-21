<script lang="ts">
  import { tick } from 'svelte';
  let {
    label,
    more,
    busy = false,
    reading,
    failed = false,
    auto = true,
    announce = false,
    action = 'Show more',
    onmore,
  }: {
    /** How much of the list is shown, such as "Showing 50 of 1,240" or "1,240 games". */
    label: string;
    /** There is more to show. */
    more: boolean;
    /** Nothing more can be asked for right now. */
    busy?: boolean;
    /** A read this list asked for is under way. A list that also refreshes on a timer sets it. */
    reading?: boolean;
    /** The last read failed. It is not tried again until the button is pressed. */
    failed?: boolean;
    /** Show more as the end of the list comes near, without waiting for the button. */
    auto?: boolean;
    /** Read the count aloud when it changes. For the one main list of a screen. */
    announce?: boolean;
    action?: string;
    onmore: () => void;
  } = $props();
  const loading = $derived(reading ?? busy);
  let node: HTMLElement | null = null;
  let observer: IntersectionObserver | null = null;
  function near() {
    if (auto && more && !busy && !failed) onmore();
  }
  function watch(element: HTMLElement) {
    if (typeof IntersectionObserver === 'undefined') return {};
    node = element;
    observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) near();
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(element);
    return {
      destroy() {
        observer?.disconnect();
        observer = null;
        node = null;
      },
    };
  }
  // The end moves when the list grows. Observing again reports where it is now.
  let mounted = false;
  $effect(() => {
    void label;
    const idle = more && !busy;
    // The first observation already reports where the end starts out.
    if (!mounted) {
      mounted = true;
      return;
    }
    if (!idle) return;
    void tick().then(() => {
      if (!observer || !node) return;
      observer.unobserve(node);
      observer.observe(node);
    });
  });
</script>

<div class="list-more" use:watch>
  <p class="dim" role={announce ? 'status' : undefined}>{label}</p>
  {#if more}<button type="button" disabled={busy} onclick={onmore}
      >{loading ? 'Loading more…' : failed ? 'Try again' : action}</button
    >{/if}
</div>

<style>
  .list-more {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    margin-top: var(--space-6);
    min-height: var(--control-height-touch);
  }
  .list-more p {
    margin: 0;
    font-size: var(--text-small);
  }
</style>
