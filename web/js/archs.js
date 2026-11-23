// The microarchitecture menu: display names and order for the configurations of data/uarch.json. No DOM.

// Stock uiCA models, newest first (an explicit order: several share a year).
export const INTEL_ORDER = ['RKL', 'TGL', 'ICL', 'CLX', 'CFL', 'SKX', 'KBL', 'SKL', 'BDW', 'HSW', 'IVB', 'SNB'];
export const EXPERIMENTAL_ORDER = ['ZEN3', 'ADL-P', 'ICX'];

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
  ICL: { name: 'Ice Lake', year: 2019 },
  TGL: { name: 'Tiger Lake', year: 2020 },
  RKL: { name: 'Rocket Lake', year: 2021 },
  ZEN3: { name: 'AMD Zen 3' },
  'ADL-P': { name: 'Alder Lake P-core' },
  ICX: { name: 'Ice Lake server' },
};

export const DEFAULT_ARCH = 'SKL';
export const GROUP_STOCK = 'Intel';
export const GROUP_EXPERIMENTAL = 'Experimental (this fork)';

export function archTitle(key) {
  const i = ARCH_INFO[key];
  if (!i) return key;
  return i.year ? `${key} · ${i.name} (${i.year})` : `${key} · ${i.name}`;
}

function ordered(keys, order) {
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  return keys.map((k, i) => [k, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
}

// uarch: the parsed data/uarch.json. Returns the groups of the menu:
// [{label, experimental, items: [{key, title, table, chip}]}]. Configurations with "_" in the key (the ablation
// variants of the uiCA paper) are left out; configurations this file does not know are still listed, by key.
export function archGroups(uarch) {
  const configs = uarch?.configs ?? {};
  const keys = Object.keys(configs).filter((k) => !k.includes('_'));
  const item = (k) => ({ key: k, title: archTitle(k), table: configs[k].name, chip: configs[k].XEDName });
  const stock = ordered(keys.filter((k) => !configs[k].experimental), INTEL_ORDER).map(item);
  const experimental = ordered(keys.filter((k) => configs[k].experimental), EXPERIMENTAL_ORDER).map(item);
  const groups = [];
  if (stock.length) groups.push({ label: GROUP_STOCK, experimental: false, items: stock });
  if (experimental.length) groups.push({ label: GROUP_EXPERIMENTAL, experimental: true, items: experimental });
  return groups;
}
