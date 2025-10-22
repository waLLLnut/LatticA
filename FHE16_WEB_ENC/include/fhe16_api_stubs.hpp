#pragma once
#include <cstdint>


struct FHE16PARAM {
int _PK_row;
int _PK_col;
int _PK_Q;
double _Q_TOT;
double _sigma_bs;
};


class EV {
public:
// Returns pointer to PK as int32_t array of size _PK_row * _PK_col
const int32_t* GetPKRaw32() const; // implemented in your real library
};


class FHE16ParamProvider {
public:
const FHE16PARAM* GetFHE16PARAM() const; // implemented in your real library
const EV* GetEV() const; // implemented in your real library
};


// Global handle provided by your lib
extern FHE16ParamProvider* G_FHE16_PARAM;










