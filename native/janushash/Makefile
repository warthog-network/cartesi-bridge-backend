CXX ?= g++
CXXFLAGS ?= -O2 -std=c++20 -fno-lto -Iinclude -Iinclude/crypto/verushash -Wno-unused -Wno-sign-compare
SRCS = src/verushash.cpp src/verus_clhash_port.cpp src/sha2.cpp src/memzero.cpp main.cpp
OBJS = $(SRCS:.cpp=.o)

ifeq ($(TARGET),riscv64)
  CXX = riscv64-linux-gnu-g++
  CXXFLAGS += -DVERUS_SOFT_SIMD
endif

# Host: prefer native AES if x86
ifneq ($(TARGET),riscv64)
  UNAME_M := $(shell uname -m)
  ifeq ($(UNAME_M),x86_64)
    CXXFLAGS += -maes -msse4.1 -mpclmul
  else
    CXXFLAGS += -DVERUS_SOFT_SIMD
  endif
endif

.PHONY: all clean
all: janushash-check
# LDFLAGS e.g. -static for Cartesi riscv image
LDFLAGS ?=
janushash-check: $(OBJS)
	$(CXX) $(CXXFLAGS) $(LDFLAGS) -o $@ $(OBJS) -lpthread
%.o: %.cpp
	$(CXX) $(CXXFLAGS) -c -o $@ $<
clean:
	rm -f $(OBJS) janushash-check
