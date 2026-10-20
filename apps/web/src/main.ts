import { ContentClient } from '@ecs/client';
import { mount } from 'svelte';
import App from './App.svelte';
import type { ServerContext } from './lib/application';
import { createSessionStore } from './lib/session';
import './app.css';

const target = document.getElementById('app');
if (!target) throw new Error('The page is missing its mount point');

// Context identity is a lifetime counter, not a secret; HTTP LAN origins lack randomUUID.
let contextSequence = 0;
function createBrowserContext(): ServerContext {
  const origin = window.location.origin;
  return {
    key: `browser-context-${++contextSequence}`,
    origin,
    label: 'Emulator Content Server',
    client: new ContentClient(origin),
    sessions: createSessionStore(origin),
    openPlayer(relativeHref) {
      window.location.assign(new URL(relativeHref, origin));
    },
  };
}
export default mount(App, { target, props: { context: createBrowserContext() } });

// A development build is what `pnpm dev` serves. The bundle name changes when
// the page is rebuilt, which is the signal to load the new one.
if (import.meta.env.MODE === 'development') {
  const bundle = (html: string) => /assets\/index-[^"]+/.exec(html)?.[0] ?? '';
  const read = () =>
    fetch(import.meta.env.BASE_URL, { cache: 'no-store' }).then((response) => response.text());
  void read().then((html) => {
    let seen = bundle(html);
    setInterval(() => {
      void read().then((next) => {
        const name = bundle(next);
        if (seen && name && name !== seen) location.reload();
        if (name) seen = name;
      });
    }, 1_000);
  });
}
