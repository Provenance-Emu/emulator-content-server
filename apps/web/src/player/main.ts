import { mount } from 'svelte';
import Player from './Player.svelte';
import '../app.css';
import './player.css';

const target = document.getElementById('app');
if (!target) throw new Error('The player mount point is missing');
mount(Player, { target });
