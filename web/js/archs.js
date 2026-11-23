// The microarchitecture menu: display names and order for the configurations of data/uarch.json. No DOM.

// All models in one list, in order of release (an explicit order: several share a year). The prototypes are the
// experimental models of the fork (configs[k].experimental in uarch.json).
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
export const GROUP_LABEL = 'by release date';
export const PROTOTYPE = 'prototype';

// The share of loops predicted within 10% of the measured throughput, for the prototype models: held-out random loops and
// real-code blocks, the "after" rows of docs/ACCURACY.md (tests-js/web_details.mjs checks that they agree).
export const ACCURACY_URL = 'https://github.com/jtl06/wuica/blob/main/docs/ACCURACY.md';
export const ACCURACY = Object.freeze({
  ZEN3: { random: 84.4, real: 87.7 },
  'ADL-P': { random: 90.9, real: 92.6 },
  ICX: { random: 85.8, real: 89.7 },
});
// "within 10%: 84% random · 89% real code", or '' for a model without numbers
export function accuracyNote(key) {
  const a = ACCURACY[key];
  return a ? `within 10%: ${Math.round(a.random)}% random · ${Math.round(a.real)}% real code` : '';
}

// experimental: the model is a prototype of the fork (shown after the name)
export function archTitle(key, experimental = false) {
  const i = ARCH_INFO[key];
  const base = !i ? key : i.year ? `${key} · ${i.name} (${i.year})` : `${key} · ${i.name}`;
  return experimental ? `${base} · ${PROTOTYPE}` : base;
}

function ordered(keys, order) {
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  return keys.map((k, i) => [k, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
}

// uarch: the parsed data/uarch.json. Returns the groups of the menu (one group, in order of release):
// [{label, items: [{key, title, table, chip, experimental}]}]. Configurations with "_" in the key (the ablation
// variants of the uiCA paper) are left out; configurations this file does not know are listed last, by key.
export function archGroups(uarch) {
  const configs = uarch?.configs ?? {};
  const keys = Object.keys(configs).filter((k) => !k.includes('_'));
  const item = (k) => {
    const experimental = !!configs[k].experimental;
    return { key: k, title: archTitle(k, experimental), table: configs[k].name, chip: configs[k].XEDName, experimental };
  };
  const items = ordered(keys, ARCH_ORDER).map(item);
  return items.length ? [{ label: GROUP_LABEL, items }] : [];
}
