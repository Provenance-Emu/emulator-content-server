import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const target = document.getElementById('app');
if (!target) throw new Error('The page is missing its mount point');

export default mount(App, { target });

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
