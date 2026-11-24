//! A fast hasher for maps with small keys (integers, short strings) that are only looked up, never iterated (iteration order
//! would depend on the hash; see "Rules for an exact port" in docs/DESIGN.md). The hash function of rustc (FxHash).

use std::borrow::Borrow;
use std::collections::{HashMap, HashSet};
use std::hash::{BuildHasher, BuildHasherDefault, Hash, Hasher};

#[derive(Default, Clone, Copy)]
pub struct FxHasher {
    hash: u64,
}

const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

impl FxHasher {
    #[inline]
    fn add(&mut self, word: u64) {
        self.hash = (self.hash.rotate_left(5) ^ word).wrapping_mul(SEED);
    }
}

impl Hasher for FxHasher {
    #[inline]
    fn write(&mut self, bytes: &[u8]) {
        let mut chunks = bytes.chunks_exact(8);
        for c in &mut chunks {
            self.add(u64::from_le_bytes(c.try_into().unwrap()));
        }
        let rest = chunks.remainder();
        if !rest.is_empty() {
            let mut buf = [0u8; 8];
            buf[..rest.len()].copy_from_slice(rest);
            self.add(u64::from_le_bytes(buf));
        }
    }
    #[inline]
    fn write_u8(&mut self, i: u8) {
        self.add(i as u64);
    }
    #[inline]
    fn write_u32(&mut self, i: u32) {
        self.add(i as u64);
    }
    #[inline]
    fn write_u64(&mut self, i: u64) {
        self.add(i);
    }
    #[inline]
    fn write_usize(&mut self, i: usize) {
        self.add(i as u64);
    }
    #[inline]
    fn finish(&self) -> u64 {
        self.hash
    }
}

/// The hasher of the maps of the instruction tables (`IndexMap`s, whose order does not depend on the hasher).
pub type FxBuildHasher = BuildHasherDefault<FxHasher>;

/// A hash map that can only be looked up: no `iter`, `keys`, `values`, `into_iter`, `drain`, `retain` or anything else that
/// visits its entries in the hash's order, so "never iterate a hash map" (docs/DESIGN.md, "Rules for an exact port") is
/// checked by the compiler. A map that must be iterated is an `IndexMap` (insertion order) or is sorted first.
pub struct LookupMap<K, V, S = FxBuildHasher>(HashMap<K, V, S>);

impl<K, V, S: Default> Default for LookupMap<K, V, S> {
    fn default() -> Self {
        LookupMap(HashMap::with_hasher(S::default()))
    }
}

impl<K: Clone, V: Clone, S: Clone> Clone for LookupMap<K, V, S> {
    fn clone(&self) -> Self {
        LookupMap(self.0.clone())
    }
}

impl<K: std::fmt::Debug, V: std::fmt::Debug, S> std::fmt::Debug for LookupMap<K, V, S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "LookupMap({} entries)", self.0.len())
    }
}

impl<K: Hash + Eq, V, S: BuildHasher + Default> LookupMap<K, V, S> {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn with_capacity(n: usize) -> Self {
        LookupMap(HashMap::with_capacity_and_hasher(n, S::default()))
    }
}

impl<K: Hash + Eq, V, S: BuildHasher> LookupMap<K, V, S> {
    #[inline]
    pub fn get<Q: Hash + Eq + ?Sized>(&self, k: &Q) -> Option<&V>
    where
        K: Borrow<Q>,
    {
        self.0.get(k)
    }
    #[inline]
    pub fn get_mut<Q: Hash + Eq + ?Sized>(&mut self, k: &Q) -> Option<&mut V>
    where
        K: Borrow<Q>,
    {
        self.0.get_mut(k)
    }
    #[inline]
    pub fn contains_key<Q: Hash + Eq + ?Sized>(&self, k: &Q) -> bool
    where
        K: Borrow<Q>,
    {
        self.0.contains_key(k)
    }
    #[inline]
    pub fn insert(&mut self, k: K, v: V) -> Option<V> {
        self.0.insert(k, v)
    }
    #[inline]
    pub fn remove<Q: Hash + Eq + ?Sized>(&mut self, k: &Q) -> Option<V>
    where
        K: Borrow<Q>,
    {
        self.0.remove(k)
    }
    #[inline]
    pub fn entry(&mut self, k: K) -> std::collections::hash_map::Entry<'_, K, V> {
        self.0.entry(k)
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.0.len()
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    #[inline]
    pub fn clear(&mut self) {
        self.0.clear()
    }
    #[inline]
    pub fn reserve(&mut self, n: usize) {
        self.0.reserve(n)
    }
}

/// A hash set that can only be looked up (see [`LookupMap`]).
pub struct LookupSet<K, S = FxBuildHasher>(HashSet<K, S>);

impl<K, S: Default> Default for LookupSet<K, S> {
    fn default() -> Self {
        LookupSet(HashSet::with_hasher(S::default()))
    }
}

impl<K: Clone, S: Clone> Clone for LookupSet<K, S> {
    fn clone(&self) -> Self {
        LookupSet(self.0.clone())
    }
}

impl<K: std::fmt::Debug, S> std::fmt::Debug for LookupSet<K, S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "LookupSet({} entries)", self.0.len())
    }
}

impl<K: Hash + Eq, S: BuildHasher> LookupSet<K, S> {
    #[inline]
    pub fn contains<Q: Hash + Eq + ?Sized>(&self, k: &Q) -> bool
    where
        K: Borrow<Q>,
    {
        self.0.contains(k)
    }
    #[inline]
    pub fn insert(&mut self, k: K) -> bool {
        self.0.insert(k)
    }
    #[inline]
    pub fn remove<Q: Hash + Eq + ?Sized>(&mut self, k: &Q) -> bool
    where
        K: Borrow<Q>,
    {
        self.0.remove(k)
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.0.len()
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    #[inline]
    pub fn clear(&mut self) {
        self.0.clear()
    }
}

/// A lookup-only map with [`FxHasher`] (see [`LookupMap`]).
pub(crate) type FastMap<K, V> = LookupMap<K, V>;

