<script lang="ts">
  import {tick} from 'svelte';
  let {open=false,canUseGameView=false,onclose=()=>{}}:{open?:boolean;canUseGameView?:boolean;onclose?:(gameView?:boolean)=>void}=$props();
  let dialog=$state<HTMLDialogElement>();
  $effect(()=>{
    if(open&&dialog&&!dialog.open)dialog.showModal();
    else if(!open&&dialog?.open)dialog.close();
  });
  async function close(gameView=false){dialog?.close();onclose(gameView);await tick();}
</script>
<dialog bind:this={dialog} class="player-guidance" aria-label="AirPlay / Screen Mirroring" oncancel={e=>{e.preventDefault();void close();}}>
  <h2>AirPlay / Screen Mirroring</h2>
  <p>Uses your device's Screen Mirroring. This page cannot start the connection for you.</p>
  <h3>On Mac</h3>
  <p>Open Control Center → Screen Mirroring, choose your receiver, then choose the window or screen sharing option your Mac offers.</p>
  <h3>On iPhone</h3>
  <p>Open Control Center → Screen Mirroring, choose your receiver, then return to Safari and keep the game open. Switching apps or tabs, or locking the phone, may suspend the game.</p>
  <p>Keep the devices on the same local network. Screen Mirroring includes touch controls and other visible content; it does not create a separate game-only TV display.</p>
  <p><a href="https://support.apple.com/guide/mac-help/stream-content-to-apple-tv-mh40624/mac" target="_blank" rel="noopener noreferrer">Apple's Mac instructions</a> · <a href="https://support.apple.com/guide/iphone/stream-video-and-audio-from-your-iphone-iphd668e80e6/ios" target="_blank" rel="noopener noreferrer">Apple's iPhone instructions</a></p>
  <div class="player-controls"><button type="button" onclick={()=>close()}>Close guidance</button>{#if canUseGameView}<button type="button" onclick={()=>close(true)}>Use Game view</button>{/if}</div>
</dialog>
