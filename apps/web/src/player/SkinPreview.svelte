<script lang="ts">
 import type {ControllerLayout}from'./layout.js';import type{Orientation}from'./skins/types.js';
 let{layout,orientation,assets}:{layout:ControllerLayout;orientation:Orientation;assets:Record<string,string>}=$props();
 const r=$derived(layout.representations[orientation]);
 const box=(f:{x:number;y:number;width:number;height:number})=>`left:${f.x/r.reference.width*100}%;top:${f.y/r.reference.height*100}%;width:${f.width/r.reference.width*100}%;height:${f.height/r.reference.height*100}%;`;
</script>
<div class="skin-preview" style:aspect-ratio={`${r.reference.width}/${r.reference.height}`} aria-label="Skin artwork preview">
 {#each r.screens as screen(screen.id)}<div class="skin-preview-screen" style={box(screen.frame)}>Game screen</div>{/each}
 {#each r.artwork??[] as a(a.assetId)}{#if assets[a.assetId]}<img src={assets[a.assetId]} alt="Imported skin artwork" style={box(a.frame)} />{/if}{/each}
 {#each r.controls as c(c.id)}<div class="skin-preview-hit" style={box(c.frame)} title={c.action}></div>{/each}
</div>
