#pragma once
#include "hash.hpp"
#include "sha2.hpp"
#include <span>
#include <cstdint>
class HasherSHA256 {
  SHA256_CTX ctx;
public:
  HasherSHA256(){ sha256_Init(&ctx); }
  Hash finalize() {
    Hash tmp{Hash::uninitialized()};
    sha256_Final(&ctx, tmp.data());
    return tmp;
  }
  void write(const std::span<const uint8_t>& s){ sha256_Update(&ctx,s.data(),s.size()); }
  HasherSHA256& operator<<(const std::span<const uint8_t>& s){ write(s); return *this; }
  template<size_t N>
  HasherSHA256& operator<<(const std::array<uint8_t,N>& a){ write({a.data(),N}); return *this; }
};
inline Hash hashSHA256(std::span<const uint8_t> s){
  HasherSHA256 h; h<<s; return h.finalize();
}
inline Hash hashSHA256(const uint8_t*d,size_t n){ return hashSHA256(std::span<const uint8_t>(d,n)); }
template<size_t N>
inline Hash hashSHA256(const std::array<uint8_t,N>&a){ return hashSHA256(a.data(),N); }
