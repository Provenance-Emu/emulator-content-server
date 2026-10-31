<script lang="ts">
  import {onMount,tick} from 'svelte';
  import type {InputSession} from './input-session.js';
  import {actions,type PadAction,type InputCapture,type CapturedBinding} from './input-model.js';
  import {createInputEngine} from './input-engine.js';
  import type {LayoutAction} from './layout.js';
  let {session,disabled=false}:{session:InputSession;disabled?:boolean}=$props();
  let revision=$state(0),captureZone=$state<HTMLDivElement>(),inspector=$state<HTMLElement>();
  const s=$derived.by(()=>{revision;return {...session,representation:session.representation};});
  const control=$derived.by(()=>{revision;return session.control;});
  const portMap=$derived.by(()=>{revision;return session.map.ports[session.port]!;});
  const blocked=$derived(disabled||s.busy||!s.ready);
  async function act(operation:()=>void|Promise<void>){if(blocked)return;try{await operation();}catch(error){session.fail(error);}}
  function editable(){return !!document.activeElement?.matches('input,textarea,select,[contenteditable="true"]');}
  function heartbeat(){session.heartbeat(!document.hidden&&document.hasFocus()&&!editable());}
  onMount(()=>{
    const unsubscribe=session.subscribe(()=>revision++),keys=new Set<string>();
    const down=(e:KeyboardEvent)=>{const was=keys.has(e.code);keys.add(e.code);if(!session.capture||session.capture.kind!=='keyboard'||e.isComposing||e.metaKey||e.ctrlKey||e.altKey||editable())return;if(e.code==='Escape'){e.preventDefault();void session.cancelCapture();return;}if(was||e.repeat||!createInputEngine().validKey(e.code))return;e.preventDefault();void act(()=>session.bind(session.capture!.action,{kind:'keyboard',key:e.code}));};
    const up=(e:KeyboardEvent)=>{keys.delete(e.code);};
    const blur=()=>{queueMicrotask(()=>{if(!document.hasFocus()){keys.clear();session.releaseAll();}});};
    const hidden=()=>{if(document.hidden){keys.clear();session.releaseAll();}else heartbeat();};
    document.addEventListener('keydown',down,true);document.addEventListener('keyup',up,true);window.addEventListener('blur',blur);document.addEventListener('visibilitychange',hidden);
    document.addEventListener('focusin',heartbeat);window.addEventListener('focus',heartbeat);
    const heart=setInterval(heartbeat,200),poll=setInterval(()=>{void session.poll();},120);heartbeat();
    return()=>{document.removeEventListener('focusin',heartbeat);window.removeEventListener('focus',heartbeat);clearInterval(heart);clearInterval(poll);unsubscribe();document.removeEventListener('keydown',down,true);document.removeEventListener('keyup',up,true);window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',hidden);session.releaseAll();};
  });
  async function capture(kind:InputCapture['kind']){await act(async()=>{await session.startCapture(kind,session.bindingAction);await tick();captureZone?.focus({preventScroll:true});});}
  function bindMouse(e:PointerEvent){if(session.capture?.kind!=='mouse'||e.pointerType!=='mouse'||(e.target as Element).closest('button'))return;e.preventDefault();const action=session.capture.action;void act(()=>session.bind(action,{kind:'mouse',mouse:e.button}));}
  function bindWheel(e:WheelEvent){if(session.capture?.kind!=='mouse')return;e.preventDefault();const action=session.capture.action;void act(()=>session.bind(action,{kind:'mouse',mouse:e.deltaY<0?5:6}));}
  function geometry(field:'x'|'y'|'width'|'height',event:Event){if(!control)return;const value=Number((event.currentTarget as HTMLInputElement).value);if(!Number.isFinite(value))return;session.checkpoint();try{session.changeControl(control.id,{frame:{...control.frame,[field]:value}});}catch(error){session.fail(error);}}
  function setAction(event:Event){if(!control)return;const action=(event.currentTarget as HTMLSelectElement).value as LayoutAction;session.checkpoint();try{session.changeControl(control.id,{action,visual:{kind:'shape',shape:'circle',label:action.endsWith('Stick')?action:action.toUpperCase()}});}catch(error){session.fail(error);}}
  function choose(id:string){session.selected=id;const c=session.representation.controls.find(c=>c.id===id);if(c&&actions.includes(c.action as PadAction))session.bindingAction=c.action as PadAction;session.notify();}
</script>
<section class="input-controls" aria-label="Input mappings" bind:this={inspector}>
  <h2>Controls and mappings</h2>
  {#if !s.ready}<p class="dim">{s.message}</p>{/if}
  <div class="player-controls input-safety"><button type="button" onclick={()=>session.releaseAll()}>Release all controls</button><button type="button" onclick={()=>{session.releaseAll();void session.runtime.focus?.();}}>Back to game</button></div>
  {#if s.ready}
    <div class="player-controls">
      <button type="button" class:active={s.mode==='play'} disabled={blocked} onclick={()=>session.setMode('play')}>Play</button>
      <button type="button" class:active={s.mode==='reference'} disabled={blocked} onclick={()=>session.setMode('reference')}>Reference</button>
      <button type="button" class:active={s.mode==='edit'} disabled={blocked} onclick={()=>session.beginEdit()}>Edit layout</button>
    </div>
    <label><input type="checkbox" checked={s.showTouch} onchange={e=>{session.releaseAll();session.showTouch=e.currentTarget.checked;session.notify();}} /> Show touch controls</label>
    <div class="input-fields">
      <label>Player port<select aria-label="Player port" value={s.port} disabled={blocked} onchange={e=>session.setPort(Number(e.currentTarget.value))}>{#each [0,1,2,3] as port}<option value={port}>Port {port+1}</option>{/each}</select></label>
      <label>Controller<select aria-label="Controller" value={s.assignments[s.port]??''} disabled={blocked} onchange={e=>{const value=e.currentTarget.value;void act(()=>session.assign(value===''?null:Number(value)));}}><option value="">Unassigned</option>{#each s.info.devices as device (device.index)}<option value={device.index}>{device.id} · connection {device.index+1}{device.mapping==='standard'?'':' · raw layout'}</option>{/each}</select></label>
      <label>Keyboard mode<select aria-label="Keyboard mode" value={s.map.keyboardMode} disabled={blocked} onchange={e=>{const value=e.currentTarget.value;void act(()=>session.update({keyboardMode:value}));}}><option value="pad">Map to RetroPad</option><option value="native">Native keyboard passthrough</option></select></label>
      <label>Mouse mode<select aria-label="Mouse mode" value={s.map.mouseMode} disabled={blocked} onchange={e=>{const value=e.currentTarget.value;void act(()=>session.update({mouseMode:value}));}}><option value="native">Native pointer passthrough</option><option value="pad">Map buttons / wheel to RetroPad</option></select></label>
    </div>
    {#if s.info.deviceError}<p class="dim">{s.info.deviceError}</p>{:else if !s.info.devices.length}<p class="dim">Press a controller button to reveal it. Keyboard and touch controls work without a physical pad.</p>{/if}
    {#if s.models[s.port]}<p class="dim">Remembered model: {s.models[s.port]?.id}. Choose its current connection above; connection numbers are never saved.</p>{/if}
    <p class="dim">Logical RetroPad labels. Multiplayer ports and native pointer support depend on the core.</p>
    <div class="input-diagram" aria-label="Mapping reference">
      {#each actions as action,i}
        <button type="button" class:pressed={!!((s.info.states[s.port]?.buttons??0)&(1<<i))} disabled={blocked} aria-label={`Configure ${action.toUpperCase()}`} onclick={()=>{const c=s.representation.controls.find(c=>c.action===action);if(c)choose(c.id);else{session.bindingAction=action;session.notify();}}}>{action.toUpperCase()}<small>{portMap.keys[action]??'—'}</small></button>
      {/each}
    </div>
    {@const action=s.bindingAction}
    {#if s.mode!=='edit'&&actions.includes(action)}
      <h3>{action.toUpperCase()} binding</h3>
      <p>Keyboard: {portMap.keys[action]??'Unbound'}</p><div class="player-controls"><button type="button" disabled={blocked} onclick={()=>capture('keyboard')}>Rebind keyboard</button><button type="button" disabled={blocked} onclick={()=>act(()=>session.bind(action,null,'keyboard'))}>Clear keyboard binding</button></div>
      <p>Controller: {portMap.pads[action]?JSON.stringify(portMap.pads[action]):'Unbound'}</p><div class="player-controls"><button type="button" disabled={blocked||s.assignments[s.port]===null} onclick={()=>capture('controller')}>Rebind controller</button><button type="button" disabled={blocked} onclick={()=>act(()=>session.bind(action,null,'controller'))}>Clear controller binding</button></div>
      <p>Mouse: {portMap.mouse[action]===undefined?'Unbound':portMap.mouse[action]!<5?`Button ${portMap.mouse[action]!+1}`:portMap.mouse[action]===5?'Wheel up':'Wheel down'}</p><div class="player-controls"><button type="button" disabled={blocked} onclick={()=>capture('mouse')}>Rebind mouse</button><button type="button" disabled={blocked} onclick={()=>act(()=>session.bind(action,null,'mouse'))}>Clear mouse binding</button></div>
    {/if}
    {#if s.capture}<div class="input-capture" role="group" aria-label="Binding capture" tabindex="-1" bind:this={captureZone} onpointerdown={bindMouse} onwheel={bindWheel}><p>Release held inputs, then {s.capture.kind==='keyboard'?'press a key':s.capture.kind==='mouse'?'click or scroll inside this area':'press a controller button or move an axis'}. Escape cancels keyboard capture.</p><button type="button" onclick={()=>{void session.cancelCapture();}}>Cancel binding</button></div>{/if}
    <p class="dim">Live stick axes: <output aria-label="Live stick axes">{JSON.stringify((s.info.states[s.port]?.axes??[0,0,0,0]).map(n=>Math.round(n*100)/100))}</output></p>
    <details><summary>Stick axes and dead zone</summary><label>Dead zone<input type="range" min="0" max="0.8" step="0.05" value={portMap.deadzone} disabled={blocked} onchange={e=>{const value=Number(e.currentTarget.value);void act(()=>session.update({['deadzone.'+s.port]:value}));}} /></label>{#each portMap.axes as axis,i}<div class="input-axis"><label>{['Left X','Left Y','Right X','Right Y'][i]} source axis<input type="number" min="0" max="15" value={axis.index} disabled={blocked} onchange={e=>{const index=Number(e.currentTarget.value);void act(()=>session.update({[`axis.${s.port}.${i}`]:{...axis,index}}));}} /></label><label><input type="checkbox" checked={axis.inverted} disabled={blocked} onchange={e=>{const inverted=e.currentTarget.checked;void act(()=>session.update({[`axis.${s.port}.${i}`]:{...axis,inverted}}));}} /> Invert</label></div>{/each}</details>
    <button type="button" disabled={blocked} onclick={()=>act(()=>session.resetMappings())}>Restore port mappings</button>
    <label>Layout orientation<select aria-label="Layout orientation" value={s.orientationMode} disabled={blocked} onchange={e=>{session.releaseAll();session.orientationMode=e.currentTarget.value as typeof session.orientationMode;session.notify();}}><option value="auto">Automatic</option><option value="portrait">Portrait</option><option value="landscape">Landscape</option></select></label>
    {#if s.mode==='edit'}
      <p class="input-editor-warning">Controls are released while editing. The game continues running.</p>
      <label>Control<select aria-label="Control" value={control?.id??''} disabled={blocked} onchange={e=>choose(e.currentTarget.value)}>{#each s.representation.controls as c (c.id)}<option value={c.id}>{c.visual.kind==='shape'?c.visual.label:c.id} · {c.id}</option>{/each}</select></label>
      <label>Control placement<select aria-label="Control placement" value={s.representation.placement} disabled={blocked} onchange={e=>{session.setPlacement(e.currentTarget.value as 'overlay'|'underlay');}}><option value="overlay">Overlay</option><option value="underlay">Underlay / skin layout</option></select></label>
      <p class="dim">Game window and controls share one reference plane. Underlay presets reserve space below the game.</p>
      {#if control}
        <label>Logical action<select aria-label="Logical action" value={control.action} disabled={blocked} onchange={setAction}>{#each [...actions,'leftStick','rightStick'] as action}<option value={action}>{action}</option>{/each}</select></label>
        <div class="input-geometry">{#each ['x','y','width','height'] as field}<label>Control {field}<input type="number" step="1" min={field==='x'||field==='y'?0:20} value={Math.round(control.frame[field as keyof typeof control.frame])} disabled={blocked} onchange={e=>geometry(field as 'x'|'y'|'width'|'height',e)} /></label>{/each}</div>
        <label>Control opacity<input type="range" min="0.25" max="1" step="0.05" value={control.opacity} disabled={blocked} oninput={e=>{if(control){session.checkpoint();try{session.changeControl(control.id,{opacity:Number(e.currentTarget.value)});}catch(error){session.fail(error);}}}} /></label>
      {/if}
      <div class="player-controls"><button type="button" disabled={blocked} onclick={()=>session.addControl()}>Add control</button><button type="button" disabled={blocked||!control} onclick={()=>session.removeControl()}>Remove control</button><button type="button" disabled={blocked} onclick={()=>session.undo()}>Undo edit</button></div>
      <div class="player-controls"><button type="button" disabled={blocked} onclick={()=>session.restorePreset('compact')}>Compact preset</button><button type="button" disabled={blocked} onclick={()=>session.restorePreset('standard')}>Standard preset</button></div>
      <div class="player-controls"><button type="button" disabled={blocked} onclick={()=>session.applyEdit()}>Apply layout</button><button type="button" disabled={s.busy} onclick={()=>session.cancelEdit()}>Cancel edits</button></div>
    {/if}
    <div class="player-controls"><button type="button" disabled={blocked||s.mode==='edit'} onclick={()=>act(()=>session.remember('core'))}>Remember for this core</button>{#if session.store.hasGame}<button type="button" disabled={blocked||s.mode==='edit'} onclick={()=>act(()=>session.remember('game'))}>Remember for this game</button>{/if}</div>
    <div class="player-controls"><button type="button" disabled={blocked} onclick={()=>act(()=>session.clearPreferences('core'))}>Clear core input preferences</button>{#if session.store.hasGame}<button type="button" disabled={blocked} onclick={()=>act(()=>session.clearPreferences('game'))}>Clear game input preferences</button>{/if}</div>
    <p class="dim">Local to this browser and exact build. Changes remain session-only until remembered. Editing supports procedural controls; skin file import comes later.</p>
  {/if}
  <p role="status">{s.message}</p>
  {#if s.failure}<p class="problem" role="alert">{s.failure}</p>{/if}
</section>
