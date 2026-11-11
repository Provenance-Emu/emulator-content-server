import '@ecs/web/app.css';
import { applyTheme, readTheme } from '@ecs/web/lib/theme';
import { mount } from 'svelte';
import LibraryWindow from './LibraryWindow.svelte';
import { createDesktopSelection } from './lib/application';
import { openExternal } from './lib/windows';

applyTheme(readTheme());

const target = document.getElementById('app');
if (!target) throw new Error('The library mount point is missing');
const selection = createDesktopSelection({ openExternal });
mount(LibraryWindow, { target, props: { selection } });
window.addEventListener('pagehide', () => selection.dispose(), { once: true });
