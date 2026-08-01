#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>
#include <span>
#include "crypto/verushash/verushash.hpp"
#include "crypto/hasher_sha256.hpp"
#include "crypto/hash.hpp"

static std::vector<uint8_t> parse_hex(const char* hex) {
  std::string h(hex);
  if (h.rfind("0x",0)==0) h=h.substr(2);
  std::vector<uint8_t> out(h.size()/2);
  for (size_t i=0;i<out.size();++i){unsigned b;sscanf(h.c_str()+2*i,"%02x",&b);out[i]=b;}
  return out;
}
static std::string to_hex(const uint8_t*p,size_t n){
  static const char*H="0123456789abcdef"; std::string s(n*2,'0');
  for(size_t i=0;i<n;++i){s[2*i]=H[p[i]>>4];s[2*i+1]=H[p[i]&0xf];} return s;
}

// CustomFloat simplified from warthog
struct CF {
  uint32_t mantissa=0; int32_t exponent=0; bool positive=true;
  CF()=default;
  CF(int32_t e,uint32_t m,bool p=true):mantissa(m),exponent(e),positive(p){}
  CF(const Hash& h){
    positive=true; int32_t e=0; size_t i=0;
    for(;i<h.size();++i){ if(h[i]!=0) break; e-=8; }
    uint64_t tmp=0;
    for(size_t j=0;;++j){ if(i<h.size()) tmp|=h[i++]; else tmp|=0xFFu; if(j>=3)break; tmp<<=8; }
    while(tmp && tmp<0x80000000ull){ tmp<<=1; e-=1; }
    while(tmp>=(1ull<<32)){ tmp>>=1; e+=1; }
    mantissa=(uint32_t)tmp; exponent=e;
  }
  double to_double() const {
    if(!mantissa) return 0;
    return (positive?1.0:-1.0)*double(mantissa)*std::ldexp(1.0, exponent-31);
  }
  friend bool operator<(const CF&a,const CF&b){
    if(a.mantissa==0&&b.mantissa==0) return false;
    if(a.positive!=b.positive) return b.positive;
    if(!a.positive){ if(a.exponent!=b.exponent) return a.exponent>b.exponent; return a.mantissa>b.mantissa; }
    if(a.exponent!=b.exponent) return a.exponent<b.exponent;
    return a.mantissa<b.mantissa;
  }
  CF operator*(const CF&o) const {
    if(!mantissa||!o.mantissa) return CF();
    uint64_t prod=uint64_t(mantissa)*uint64_t(o.mantissa);
    int64_t e=int64_t(exponent)+int64_t(o.exponent);
    while(prod>=(1ull<<32)){ prod>>=1; e+=1; }
    while(prod && prod<0x80000000ull){ prod<<=1; e-=1; }
    return CF((int32_t)e,(uint32_t)prod, positive==o.positive);
  }
};
static CF cf_pow(const CF& base, const CF& expf){
  double r=std::pow(base.to_double(), expf.to_double());
  if(r<=0) return CF();
  int exp2=0; double mant=std::frexp(r,&exp2);
  uint64_t m=(uint64_t)(mant*(double)(1ull<<32));
  int32_t e2=exp2-32;
  while(m&&m<0x80000000ull){m<<=1;e2-=1;}
  while(m>=(1ull<<32)){m>>=1;e2+=1;}
  return CF(e2,(uint32_t)m,true);
}
static bool product_lt_target(const CF& hp, uint32_t target_be){
  uint32_t zerosTarget=target_be>>22;
  uint32_t bits22=target_be & ((1u<<22)-1);
  if(!hp.positive||hp.exponent>0) return false;
  uint32_t zerosHp=uint32_t(-hp.exponent);
  if(zerosTarget>zerosHp) return false;
  uint64_t bits32=uint64_t(bits22)<<10;
  if(zerosTarget<zerosHp) return true;
  return hp.mantissa<bits32;
}

int main(int argc,char**argv){
  if(argc<2){fprintf(stderr,"usage: %s <header80hex>\n",argv[0]);return 2;}
  auto raw=parse_hex(argv[1]);
  if(raw.size()!=80){fprintf(stderr,"need 80 bytes\n");return 2;}
  Hash verus=verus_hash_v2_2(raw);
  Hash h1=hashSHA256(std::span<const uint8_t>(raw.data(),raw.size()));
  Hash block=hashSHA256(h1);
  Hash sha256t=hashSHA256(block);
  CF verusF(verus), shaF(sha256t);
  CF c(-7,2748779069u);
  double jn=1.0; bool ok=false;
  if(!(shaF<c)){
    CF factor(0,3006477107u);
    CF prod=verusF*cf_pow(shaF,factor);
    jn=prod.to_double();
    uint32_t tgt=(uint32_t(raw[32])<<24)|(uint32_t(raw[33])<<16)|(uint32_t(raw[34])<<8)|uint32_t(raw[35]);
    ok=product_lt_target(prod,tgt);
  }
  printf("{\"ok\":%s,\"blockHash\":\"%s\",\"verusHash\":\"%s\",\"sha256t\":\"%s\",\"janusNumber\":%.17g,\"target\":\"%s\"}\n",
    ok?"true":"false", to_hex(block.data(),32).c_str(), to_hex(verus.data(),32).c_str(),
    to_hex(sha256t.data(),32).c_str(), jn, to_hex(raw.data()+32,4).c_str());
  return ok?0:1;
}
// stubs that hash.cpp might need if linked - we avoid hash.cpp
extern "C" void memzero(void*p,size_t n){memset(p,0,n);}
