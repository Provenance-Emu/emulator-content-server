/* Flycast's older libretro-common names, implemented through the selected frontend. */
#include <stddef.h>

extern size_t fill_pathname_base(char *out, const char *path, size_t size);
extern char *path_remove_extension(char *path);

void fill_short_pathname_representation(char *out, const char *path, size_t size)
{
    fill_pathname_base(out, path, size);
}

void fill_short_pathname_representation_noext(char *out, const char *path, size_t size)
{
    fill_short_pathname_representation(out, path, size);
    if (size != 0)
        path_remove_extension(out);
}

/* WebGL2 has no EXT_buffer_storage. The selected frontend guards this pointer
 * behind extension detection; Flycast's older GL table does not declare it. */
void (*__rglgen_glBufferStorageEXT)(unsigned int, ptrdiff_t, const void *, unsigned int) = 0;
