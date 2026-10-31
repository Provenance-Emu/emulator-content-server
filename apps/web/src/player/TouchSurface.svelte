<script lang="ts">
  import { onMount } from 'svelte';
  import type { InputSession } from './input-session.js';
  import { actionBit, touchStickAxes, type PadAction } from './input-model.js';
  import { fitLayout,hitRect,transformRect,controlLabel,controlButtons,type LayoutControl,type Rect } from './layout.js';
  let {session,stage,gameMount,assets={}}:{session:InputSession;stage:HTMLElement;gameMount:HTMLElement;assets?:Record<string,string>}=$props();
  let revision=$state(0),width=$state(0),height=$state(0);
  const representation=$derived.by(()=>{revision;return session.representation;});
  const editing=$derived.by(()=>{revision;return session.mode==='edit';});
  const visible=$derived.by(()=>{revision;return session.ready&&session.showTouch;});
  let safe=$state({top:0,right:0,bottom:0,left:0});
  const fit=$derived.by(()=>{const f=fitLayout(representation.reference,Math.max(0,width-safe.left-safe.right),Math.max(0,height-safe.top-safe.bottom));return{...f,x:f.x+safe.left,y:f.y+safe.top};});
  const pressed=$derived.by(()=>{revision;return session.info.states[session.port]?.buttons??0;});
  let lastEpoch=-1,lastOrientation='';
  const pointers=new Map<number,{id:string;control:LayoutControl;startX:number;startY:number;frame:Rect;resize:boolean}>();
  function refresh(){const css=getComputedStyle(stage);safe={top:parseFloat(css.getPropertyValue('--skin-safe-top'))||0,right:parseFloat(css.getPropertyValue('--skin-safe-right'))||0,bottom:parseFloat(css.getPropertyValue('--skin-safe-bottom'))||0,left:parseFloat(css.getPropertyValue('--skin-safe-left'))||0};width=stage.clientWidth;height=stage.clientHeight;const o=session.orientationMode==='auto'?(width>height?'landscape':'portrait'):session.orientationMode;if(session.orientation!==o){session.releaseAll();session.orientation=o;session.notify();}}
  onMount(()=>{const unsubscribe=session.subscribe(()=>{if(lastEpoch!==session.gestureEpoch||lastOrientation!==session.orientation){pointers.clear();lastEpoch=session.gestureEpoch;lastOrientation=session.orientation;}revision++;});const observer=new ResizeObserver(refresh);observer.observe(stage);refresh();const up=(e:PointerEvent)=>finish(e,false),cancel=(e:PointerEvent)=>finish(e,true);document.addEventListener('pointerup',up);document.addEventListener('pointercancel',cancel);return()=>{unsubscribe();observer.disconnect();document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',cancel);session.releaseAll();Object.assign(gameMount.style,{position:'',left:'',top:'',width:'',height:''});};});
  $effect(()=>{revision;const orientation=session.orientationMode==='auto'?(width>height?'landscape':'portrait'):session.orientationMode;if(session.orientation!==orientation){session.releaseAll();session.orientation=orientation;session.notify();}});
  $effect(()=>{revision;if(!session.ready)return;const screen=transformRect(representation.screens[0]!.frame,fit);const styles={position:'absolute',left:screen.x+'px',top:screen.y+'px',width:screen.width+'px',height:screen.height+'px'};for(const [key,value] of Object.entries(styles))if(gameMount.style.getPropertyValue(key)!==value)gameMount.style.setProperty(key,value);});
  function start(e:PointerEvent,c:LayoutControl,resize=false){if(!session.ready||!session.showTouch)return;if(session.mode==='reference'){session.selected=c.id;session.notify();return;}if(e.button!==0)return;e.preventDefault();session.selected=c.id;session.notify();if(editing)session.checkpoint();const target=e.currentTarget as HTMLElement;try{target.setPointerCapture(e.pointerId);}catch{return;}pointers.set(e.pointerId,{id:'pointer-'+e.pointerId,control:c,startX:e.clientX,startY:e.clientY,frame:{...c.frame},resize});if(!editing){session.heartbeat(!document.hidden&&document.hasFocus());play(e,c);}}
  function play(e:PointerEvent,c:LayoutControl){const source='pointer-'+e.pointerId;const axes=[0,0,0,0];let buttons=0;
    if(c.action==='leftStick'||c.action==='rightStick'){const r=transformRect(c.frame,fit),bounds=stage.getBoundingClientRect(),config=session.map.ports[session.port];if(!config)return;session.touch(source,0,touchStickAxes((e.clientX-bounds.left-r.x-r.width/2)/(r.width/2),(e.clientY-bounds.top-r.y-r.height/2)/(r.height/2),c.action==='rightStick',config));return;}
    else if(c.action==='dpad'){const r=transformRect(c.frame,fit),bounds=stage.getBoundingClientRect(),x=(e.clientX-bounds.left-r.x-r.width/2)/(r.width/2),y=(e.clientY-bounds.top-r.y-r.height/2)/(r.height/2);if(Math.abs(x)<=1.4&&Math.abs(y)<=1.4){if(x<-.3)buttons|=actionBit('left');if(x>.3)buttons|=actionBit('right');if(y<-.3)buttons|=actionBit('up');if(y>.3)buttons|=actionBit('down');}}
    else buttons=controlButtons(c).reduce((mask,a)=>mask|actionBit(a),0);
    session.touch(source,buttons,axes);
  }
  function move(e:PointerEvent){const p=pointers.get(e.pointerId);if(!p)return;e.preventDefault();if(editing){const ref=representation.reference;const frame={...p.frame};if(p.resize){frame.width=Math.max(20,Math.min(180,ref.width-frame.x,p.frame.width+(e.clientX-p.startX)/fit.scale));frame.height=Math.max(20,Math.min(180,ref.height-frame.y,p.frame.height+(e.clientY-p.startY)/fit.scale));}else{frame.x=Math.max(0,Math.min(ref.width-frame.width,p.frame.x+(e.clientX-p.startX)/fit.scale));frame.y=Math.max(0,Math.min(ref.height-frame.height,p.frame.y+(e.clientY-p.startY)/fit.scale));}try{session.changeControl(p.control.id,{frame});}catch(error){session.fail(error);}return;}
    const c=p.control;if(['up','down','left','right'].includes(c.action)){
      const dirs=representation.controls.filter(c=>['up','down','left','right'].includes(c.action));if(dirs.length!==4){play(e,c);return;}
      const centers=dirs.map(c=>{const r=transformRect(c.frame,fit);return{x:r.x+r.width/2,y:r.y+r.height/2};});const center={x:centers.reduce((n,p)=>n+p.x,0)/4,y:centers.reduce((n,p)=>n+p.y,0)/4};const radius=Math.max(...centers.map(p=>Math.max(Math.abs(p.x-center.x),Math.abs(p.y-center.y))),20);const bounds=stage.getBoundingClientRect(),x=(e.clientX-bounds.left-center.x)/radius,y=(e.clientY-bounds.top-center.y)/radius;
      let buttons=0;if(Math.abs(x)<2&&Math.abs(y)<2){if(x<-.35)buttons|=actionBit('left');if(x>.35)buttons|=actionBit('right');if(y<-.35)buttons|=actionBit('up');if(y>.35)buttons|=actionBit('down');}session.touch(p.id,buttons);
    }else play(e,c);
  }
  function finish(e:PointerEvent,cancel:boolean){const p=pointers.get(e.pointerId);if(!p)return;pointers.delete(e.pointerId);session.endTouch(p.id,cancel);if(!editing&&!cancel&&!pointers.size&&document.hasFocus()&&!document.hidden&&!document.activeElement?.matches('input,textarea,select,[contenteditable="true"]'))void session.runtime.focus?.();}
  function keyResize(e:KeyboardEvent,c:LayoutControl){const amount=e.shiftKey?10:2;if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))return;e.preventDefault();session.checkpoint();try{session.changeControl(c.id,{frame:{...c.frame,width:Math.max(20,Math.min(180,c.frame.width+(e.code==='ArrowRight'?amount:e.code==='ArrowLeft'?-amount:0))),height:Math.max(20,Math.min(180,c.frame.height+(e.code==='ArrowDown'?amount:e.code==='ArrowUp'?-amount:0)))}});}catch(error){session.fail(error);}}
</script>
{#if visible&&width>0&&height>0}
  <div class="skin-art-layer" aria-hidden="true">{#each representation.artwork??[] as a(a.assetId)}{@const rect=transformRect(a.frame,fit)}{#if assets[a.assetId]}<img src={assets[a.assetId]} alt="" style:left={rect.x+'px'} style:top={rect.y+'px'} style:width={rect.width+'px'} style:height={rect.height+'px'}/>{/if}{/each}</div>
  <div class="touch-surface" class:editing aria-label="Touch controller">
    {#each representation.controls as control (control.id)}
      {@const visual=transformRect(control.frame,fit)}{@const hit=hitRect(control,fit,width,height,safe)}
      <button type="button" class="touch-hit" class:pressed={control.action==='dpad'?!!(pressed&240):controlButtons(control).some(a=>!!(pressed&actionBit(a)))} class:selected={editing&&session.selected===control.id} aria-label={`Touch ${controlLabel(control)}`} tabindex={session.mode==='play'?-1:0} style:left={hit.x+'px'} style:top={hit.y+'px'} style:width={hit.width+'px'} style:height={hit.height+'px'} onpointerdown={e=>start(e,control)} onpointermove={move} onpointerup={e=>finish(e,false)} onpointercancel={e=>finish(e,true)} onlostpointercapture={e=>finish(e,true)}>
        <span class="touch-vector" class:hotspot={control.visual.kind==='hotspot'} class:caption={control.action==='start'||control.action==='select'} class:rect={control.visual.kind==='shape'&&control.visual.shape==='rect'} style:left={visual.x-hit.x+'px'} style:top={visual.y-hit.y+'px'} style:width={visual.width+'px'} style:height={visual.height+'px'} style:opacity={control.opacity}>{#if control.visual.kind!=='hotspot'||editing||session.mode==='reference'}{controlLabel(control)}{/if}
          {#if session.mode==='reference'}<small>{controlButtons(control).map(a=>session.map.ports[session.port]?.keys[a]??'—').join(' / ')}</small>{/if}
        </span>
      </button>
      {#if editing&&session.selected===control.id}<button type="button" class="touch-resize" aria-label={`Resize ${control.id}`} style:left={Math.min(width-28,visual.x+visual.width-14)+'px'} style:top={Math.min(height-28,visual.y+visual.height-14)+'px'} onpointerdown={e=>start(e,control,true)} onpointermove={move} onpointerup={e=>finish(e,false)} onpointercancel={e=>finish(e,true)} onlostpointercapture={e=>finish(e,true)} onkeydown={e=>keyResize(e,control)}>↔</button>{/if}
    {/each}
  </div>
{/if}
