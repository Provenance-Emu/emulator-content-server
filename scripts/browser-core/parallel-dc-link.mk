# The core carries complete copies of these codecs; link exactly one implementation.
RARCH_OBJ := $(filter-out obj-emscripten/./libretro-common/encodings/encoding_deflate.o obj-emscripten/./libretro-common/formats/rar/rrar_ppmd7.o,$(RARCH_OBJ))
LDFLAGS += -Wl,--error-limit=0
