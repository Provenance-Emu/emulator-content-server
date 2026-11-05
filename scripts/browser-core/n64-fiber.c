/* Emscripten libco backend. SPDX-License-Identifier: MIT */
#define LIBCO_C
#include <libco.h>
#include <emscripten/fiber.h>
#include <stdint.h>
#include <stdlib.h>

/* Asyncify's saved WASM frames are separate from the requested C stack. */
#define CO_ASYNCIFY_STACK_SIZE (1024u * 1024u)

typedef struct co_emscripten_thread
{
   emscripten_fiber_t context;
   void (*entry)(void);
   void *c_stack;
   void *asyncify_stack;
   struct co_emscripten_thread *caller;
   int finished;
} co_emscripten_thread;

static co_emscripten_thread co_primary;
static unsigned char co_primary_asyncify[CO_ASYNCIFY_STACK_SIZE];
static co_emscripten_thread *co_running;

cothread_t co_active(void)
{
   if (!co_running)
   {
      emscripten_fiber_init_from_current_context(&co_primary.context,
            co_primary_asyncify, sizeof(co_primary_asyncify));
      co_running = &co_primary;
   }
   return co_running;
}

static void co_entry(void *argument)
{
   co_emscripten_thread *thread = (co_emscripten_thread*)argument;
   thread->entry();
   thread->finished = 1;
   co_running = thread->caller;
   /* A fiber entry returning would terminate the entire Emscripten program. */
   emscripten_fiber_swap(&thread->context, &co_running->context);
   abort();
}

cothread_t co_create(unsigned int size, void (*entry)(void))
{
   co_emscripten_thread *thread;
   uintptr_t aligned;
   if (!size || !entry || size + 15u < size)
      return NULL;
   co_active();
   thread = (co_emscripten_thread*)calloc(1, sizeof(*thread));
   if (!thread)
      return NULL;
   thread->c_stack = malloc(size + 15u);
   thread->asyncify_stack = malloc(CO_ASYNCIFY_STACK_SIZE);
   if (!thread->c_stack || !thread->asyncify_stack)
   {
      co_delete(thread);
      return NULL;
   }
   aligned = ((uintptr_t)thread->c_stack + 15u) & ~(uintptr_t)15u;
   size &= ~15u;
   if (!size)
   {
      co_delete(thread);
      return NULL;
   }
   thread->entry = entry;
   emscripten_fiber_init(&thread->context, co_entry, thread,
         (void*)aligned, size, thread->asyncify_stack, CO_ASYNCIFY_STACK_SIZE);
   return thread;
}

void co_delete(cothread_t handle)
{
   co_emscripten_thread *thread = (co_emscripten_thread*)handle;
   if (!thread)
      return;
   if (thread == &co_primary || thread == co_running)
      abort();
   free(thread->asyncify_stack);
   free(thread->c_stack);
   free(thread);
}

void co_switch(cothread_t handle)
{
   co_emscripten_thread *thread = (co_emscripten_thread*)handle;
   co_emscripten_thread *previous = (co_emscripten_thread*)co_active();
   if (!thread || thread->finished)
      abort();
   if (thread == previous)
      return;
   thread->caller = previous;
   co_running = thread;
   emscripten_fiber_swap(&previous->context, &thread->context);
}
