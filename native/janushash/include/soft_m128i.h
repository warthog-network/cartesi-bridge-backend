#pragma once
#include <stdint.h>
#include <string.h>
/* Minimal software __m128i for RISC-V / portable builds */
typedef struct { alignas(16) uint8_t b[16]; } __m128i;

#ifdef __cplusplus
static inline __m128i operator^(__m128i a, __m128i b){
  __m128i r; for(int i=0;i<16;i++) r.b[i]=a.b[i]^b.b[i]; return r;
}
static inline __m128i operator|(__m128i a, __m128i b){
  __m128i r; for(int i=0;i<16;i++) r.b[i]=a.b[i]|b.b[i]; return r;
}
static inline __m128i operator&(__m128i a, __m128i b){
  __m128i r; for(int i=0;i<16;i++) r.b[i]=a.b[i]&b.b[i]; return r;
}
#endif

static inline __m128i _mm_setzero_si128(void){ __m128i r; memset(&r,0,16); return r; }
static inline __m128i _mm_loadu_si128(const __m128i*p){ return *p; }
static inline __m128i _mm_load_si128(const __m128i*p){ return *p; }
static inline void _mm_store_si128(__m128i*p, __m128i a){ *p=a; }
static inline void _mm_storeu_si128(__m128i*p, __m128i a){ *p=a; }
static inline __m128i _mm_xor_si128(__m128i a,__m128i b){
  __m128i r; for(int i=0;i<16;i++) r.b[i]=a.b[i]^b.b[i]; return r;
}
static inline __m128i _mm_or_si128(__m128i a,__m128i b){
  __m128i r; for(int i=0;i<16;i++) r.b[i]=a.b[i]|b.b[i]; return r;
}
static inline __m128i _mm_and_si128(__m128i a,__m128i b){
  __m128i r; for(int i=0;i<16;i++) r.b[i]=a.b[i]&b.b[i]; return r;
}
static inline __m128i _mm_set_epi64x(long long hi, long long lo){
  __m128i r; memcpy(r.b,&lo,8); memcpy(r.b+8,&hi,8); return r;
}
static inline __m128i _mm_set_epi32(int e3,int e2,int e1,int e0){
  __m128i r; int v[4]={e0,e1,e2,e3}; memcpy(r.b,v,16); return r;
}
static inline __m128i _mm_cvtsi32_si128(int a){ __m128i r; memset(&r,0,16); memcpy(r.b,&a,4); return r; }
static inline int _mm_cvtsi128_si32(__m128i a){ int x; memcpy(&x,a.b,4); return x; }
static inline long long _mm_cvtsi128_si64(__m128i a){ long long x; memcpy(&x,a.b,8); return x; }
static inline __m128i _mm_cvtsi64_si128(long long a){ __m128i r; memset(&r,0,16); memcpy(r.b,&a,8); return r; }
/* AES / CLMUL stubs — portable port uses its own aesenc and clmul emu */
static inline __m128i _mm_aesenc_si128(__m128i a, __m128i b){ (void)b; return a; }
static inline __m128i _mm_clmulepi64_si128(__m128i a, __m128i b, int imm){ (void)a;(void)b;(void)imm; return _mm_setzero_si128(); }
static inline __m128i _mm_shuffle_epi8(__m128i a, __m128i b){ (void)b; return a; }
static inline __m128i _mm_srli_si128(__m128i a, int imm){
  __m128i r; memset(&r,0,16);
  if(imm>=16) return r;
  memmove(r.b, a.b+imm, 16-imm);
  return r;
}
static inline __m128i _mm_unpacklo_epi32(__m128i a,__m128i b){
  uint32_t A[4],B[4],R[4]; memcpy(A,a.b,16); memcpy(B,b.b,16);
  R[0]=A[0];R[1]=B[0];R[2]=A[1];R[3]=B[1];
  __m128i r; memcpy(r.b,R,16); return r;
}
static inline __m128i _mm_unpackhi_epi32(__m128i a,__m128i b){
  uint32_t A[4],B[4],R[4]; memcpy(A,a.b,16); memcpy(B,b.b,16);
  R[0]=A[2];R[1]=B[2];R[2]=A[3];R[3]=B[3];
  __m128i r; memcpy(r.b,R,16); return r;
}
static inline __m128i _mm_setr_epi8(char b0,char b1,char b2,char b3,char b4,char b5,char b6,char b7,
  char b8,char b9,char b10,char b11,char b12,char b13,char b14,char b15){
  __m128i r; char v[16]={b0,b1,b2,b3,b4,b5,b6,b7,b8,b9,b10,b11,b12,b13,b14,b15}; memcpy(r.b,v,16); return r;
}
