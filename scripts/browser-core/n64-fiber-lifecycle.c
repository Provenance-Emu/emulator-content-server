/* Original regression program; no console firmware or content. */
#include <assert.h>
#include <limits.h>
#include <malloc.h>
#include <stdio.h>
#include <libco.h>

static cothread_t primary;
static cothread_t first;
static cothread_t second;
static int first_value;
static int second_value;
static int child_value;

static void child_entry(void)
{
   child_value = 1;
   co_switch(first);
   child_value = 2;
}

static void nested_yield(int *value)
{
   volatile unsigned int preserved[64];
   unsigned int i;
   for (i = 0; i < 64; ++i)
      preserved[i] = i * 17 + 3;
   *value += 1;
   co_switch(primary);
   for (i = 0; i < 64; ++i)
      assert(preserved[i] == i * 17 + 3);
   *value += 10;
}

static void first_entry(void)
{
   int local = 40;
   cothread_t child;
   assert(co_active() == first);
   nested_yield(&local);
   assert(co_active() == first);
   assert(local == 51);
   child = co_create(32768, child_entry);
   assert(child != NULL);
   co_switch(child);
   assert(child_value == 1 && co_active() == first);
   co_switch(child);
   assert(child_value == 2 && co_active() == first);
   co_delete(child);
   first_value = local;
   co_switch(primary);
   first_value = 99;
   /* Returning must resume the caller, without exiting the WASM program. */
}

static void second_entry(void)
{
   int local = 100;
   assert(co_active() == second);
   nested_yield(&local);
   assert(local == 111);
   second_value = local;
}

static void immediate_return(void)
{
   first_value += 1;
}

int main(void)
{
   int baseline;
   unsigned int i;
   primary = co_active();
   assert(primary != NULL && co_active() == primary);
   co_switch(primary);
   assert(co_create(0, immediate_return) == NULL);
   assert(co_create(65536, NULL) == NULL);
   assert(co_create(UINT_MAX, immediate_return) == NULL);
   baseline = mallinfo().uordblks;
   first = co_create(65536, first_entry);
   second = co_create(65536, second_entry);
   assert(first != NULL && second != NULL && first != second);
   co_switch(first);
   assert(co_active() == primary && first_value == 0);
   co_switch(second);
   assert(second_value == 0);
   co_switch(first);
   assert(first_value == 51);
   co_switch(second);
   assert(co_active() == primary && second_value == 111);
   co_delete(second);
   co_switch(first);
   assert(co_active() == primary && first_value == 99);
   co_delete(first);
   co_delete(NULL);
   for (i = 0; i < 100; ++i)
   {
      first = co_create(65536, immediate_return);
      assert(first != NULL);
      co_switch(first);
      assert(co_active() == primary);
      co_delete(first);
   }
   assert(first_value == 199);
   assert(mallinfo().uordblks == baseline);
   puts("real N64 fiber lifecycle passed");
   return 0;
}
