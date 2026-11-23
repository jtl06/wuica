// Display names, release years and order of the microarchitecture models (the keys of `configs` in uarch.json).

// In order of release (explicit: several share a year).
export const ARCH_ORDER = ['SNB', 'IVB', 'HSW', 'BDW', 'SKL', 'KBL', 'SKX', 'CFL', 'CLX', 'ICL', 'TGL', 'ZEN3', 'RKL', 'ICX', 'ADL-P'];

export const ARCH_INFO = {
  SNB: { name: 'Sandy Bridge', year: 2011 },
  IVB: { name: 'Ivy Bridge', year: 2012 },
  HSW: { name: 'Haswell', year: 2013 },
  BDW: { name: 'Broadwell', year: 2014 },
  SKL: { name: 'Skylake', year: 2015 },
  KBL: { name: 'Kaby Lake', year: 2016 },
  SKX: { name: 'Skylake-X', year: 2017 },
  CFL: { name: 'Coffee Lake', year: 2017 },
  CLX: { name: 'Cascade Lake', year: 2019 },
  ICL: { name: 'Ice Lake client', year: 2019 },
  TGL: { name: 'Tiger Lake', year: 2020 },
  ZEN3: { name: 'AMD Zen 3', year: 2020 },
  RKL: { name: 'Rocket Lake', year: 2021 },
  ICX: { name: 'Ice Lake server', year: 2021 },
  'ADL-P': { name: 'Alder Lake P-core', year: 2021 },
};

export const DEFAULT_ARCH = 'SKL';

// configs: uarch.json's `configs`. Returns the public list: keys with "_" (uiCA's ablation variants) are left out;
// unknown keys come last, by key.
export function archList(configs) {
  const keys = Object.keys(configs).filter((k) => !k.includes('_'));
  const rank = (k) => { const i = ARCH_ORDER.indexOf(k); return i < 0 ? ARCH_ORDER.length : i; };
  keys.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return keys.map((key) => {
    const c = configs[key];
    const info = ARCH_INFO[key];
    return {
      id: key,
      name: info?.name ?? key,
      year: info?.year ?? null,
      prototype: !!c.experimental,
      table: c.name,
      xedChip: c.XEDName,
    };
  });
}
