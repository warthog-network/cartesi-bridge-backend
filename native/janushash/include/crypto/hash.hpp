#pragma once
#include <array>
#include <cstdint>
#include <cstring>
#include <optional>
#include <string>
#include <span>
class Hash : public std::array<uint8_t,32> {
public:
  static Hash uninitialized(){ return Hash{}; }
  static Hash zero(){ Hash h; h.fill(0); return h; }
  Hash()=default;
  Hash(std::array<uint8_t,32> a):array(std::move(a)){}
  Hash(const uint8_t*p){ std::memcpy(array::data(),p,32); }
  // allow unsigned char* buffers used as HashView seeds
  Hash(unsigned char*p):Hash(static_cast<const uint8_t*>(p)){}
  uint8_t* data(){ return array::data(); }
  const uint8_t* data() const { return array::data(); }
  bool operator==(const Hash&o)const{ return static_cast<const std::array<uint8_t,32>&>(*this)==o; }
  bool operator!=(const Hash&o)const{ return !(*this==o); }
};
using HashView = Hash;
using BlockHash = Hash;
