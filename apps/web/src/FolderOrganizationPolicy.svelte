<script lang="ts">
  import type { ContentClient, ContentRoot, SourceOrganizationPolicy } from '@ecs/client';
  import { onMount, onDestroy } from 'svelte';
  import { explain } from './lib/problems';
  let {client,root,onrejected}:{client:ContentClient;root:ContentRoot;onrejected?:(status:401|403)=>void}=$props();
  let policy=$state<SourceOrganizationPolicy|null>(null);
  let busy=$state(true);
  let failure=$state<string|null>(null);
  let disposed=false;
  onDestroy(()=>{disposed=true;});
  function reject(error:unknown){
    if(disposed)return;
    failure=explain(error);
    const status=(error as {status?:number})?.status;
    if(status===401||status===403){policy=null;onrejected?.(status);}
  }
  async function load(){busy=true;failure=null;try{const value=await client.sourceOrganizationPolicy(root.id);if(!disposed)policy=value;}catch(error){reject(error);}finally{if(!disposed)busy=false;}}
  async function disable(){busy=true;failure=null;try{const value=await client.setSourceOrganizationPolicy(root.id,{enabled:false});if(!disposed)policy=value;}catch(error){reject(error);}finally{if(!disposed)busy=false;}}
  onMount(()=>{void load();});
</script>
<p>{root.label}</p>
{#if busy}<p role="status">Updating organization settings…</p>{:else if policy?.enabled}
  <p role="status">Automatic {policy.mode==='move'?'Move':'Copy'} is enabled for future saved matches in this folder.</p>
  <button type="button" onclick={()=>void disable()}>Turn off automatic organization</button>
{:else if policy}<p role="status">Automatic organization is off for this folder.</p>{/if}
<p class="dim">To enable or change automatic organization, open a game in this folder and preview its destination. Existing files are not processed in bulk.</p>
{#if failure}<p role="alert" class="problem">{failure}</p><button type="button" disabled={busy} onclick={()=>void load()}>Retry organization settings</button>{/if}
