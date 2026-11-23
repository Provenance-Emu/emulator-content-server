#define _FILE_OFFSET_BITS 64
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <sys/stat.h>
/* Stands in for a disc reader: stat, then seek far and read small pieces, as a CHD decoder does. */
int main(int argc, char **argv) {
  struct stat st;
  if (stat(argv[1], &st)) { puts("stat failed"); return 1; }
  printf("size %lld\n", (long long)st.st_size);
  FILE *f = fopen(argv[1], "rb");
  if (!f) { puts("open failed"); return 1; }
  for (int i = 2; i < argc; i++) {
    long long at = atoll(argv[i]);
    uint8_t b[8];
    if (fseeko(f, (off_t)at, SEEK_SET)) { printf("seek %lld failed\n", at); continue; }
    size_t n = fread(b, 1, 8, f);
    printf("%lld:%zu:", at, n);
    for (size_t k = 0; k < n; k++) printf("%02x", b[k]);
    puts("");
  }
  fclose(f);
  return 0;
}
