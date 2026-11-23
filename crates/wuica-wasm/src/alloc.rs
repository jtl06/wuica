//! The module's global allocator: segregated free lists for small blocks, the default allocator (dlmalloc) for the others.
//!
//! An analysis makes some 10-20 thousand allocations, nearly all of them under 1 kB; with dlmalloc, `malloc`/`free`/`realloc`
//! took ~15% of the time. Rust passes the layout to `dealloc` and `realloc`, so a small block needs no header: its size class
//! follows from its size. A free block holds the pointer to the next free block of its class; new blocks are cut from chunks
//! obtained from dlmalloc. Memory of small blocks is reused only for blocks of the same class and is never returned to
//! dlmalloc (a WebAssembly memory cannot shrink anyway).
//!
//! Only for wasm32 without the `atomics` feature: the module is single-threaded, so the state needs no synchronization.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::UnsafeCell;
use std::ptr;

/// Size granularity of the classes, and the alignment that small blocks guarantee.
const GRAN: usize = 8;
/// Largest small block; larger blocks, and blocks with an alignment above `GRAN`, go to dlmalloc.
const MAX_SMALL: usize = 1024;
/// Class `i` holds blocks of `(i + 1) * GRAN` bytes.
const CLASSES: usize = MAX_SMALL / GRAN;
/// Size of the chunks from which new small blocks are cut.
const CHUNK: usize = 256 * 1024;

struct State {
    /// head of the free list of each class (null: empty)
    free: [*mut u8; CLASSES],
    /// the unused part of the current chunk
    next: usize,
    end: usize,
}

pub struct Alloc(UnsafeCell<State>);

// SAFETY: the target is single-threaded (no `atomics`), so the state is never accessed concurrently.
unsafe impl Sync for Alloc {}

impl Alloc {
    pub const fn new() -> Alloc {
        Alloc(UnsafeCell::new(State { free: [ptr::null_mut(); CLASSES], next: 0, end: 0 }))
    }
}

/// The class of a layout, or `None` if the block goes to dlmalloc. A pure function of the layout, so `alloc`, `dealloc` and
/// `realloc` agree on where a block belongs.
#[inline(always)]
fn class(size: usize, align: usize) -> Option<usize> {
    if size <= MAX_SMALL && align <= GRAN {
        Some(size.saturating_sub(1) / GRAN)
    } else {
        None
    }
}

impl Alloc {
    #[inline(always)]
    unsafe fn alloc_small(&self, c: usize) -> *mut u8 {
        let s = &mut *self.0.get();
        let head = s.free[c];
        if !head.is_null() {
            s.free[c] = *(head as *mut *mut u8);
            return head;
        }
        let size = (c + 1) * GRAN;
        if s.end - s.next < size {
            return self.refill(size);
        }
        let p = s.next;
        s.next = p + size;
        p as *mut u8
    }

    /// Starts a new chunk and cuts a block of `size` bytes from it. The rest of the old chunk goes to the free list of its size.
    #[cold]
    #[inline(never)]
    unsafe fn refill(&self, size: usize) -> *mut u8 {
        let chunk = System.alloc(Layout::from_size_align_unchecked(CHUNK, GRAN));
        if chunk.is_null() {
            return chunk;
        }
        let s = &mut *self.0.get();
        let rest = s.end - s.next;
        if rest >= GRAN {
            let c = rest / GRAN - 1;
            *(s.next as *mut *mut u8) = s.free[c];
            s.free[c] = s.next as *mut u8;
        }
        s.next = chunk as usize + size;
        s.end = chunk as usize + CHUNK;
        chunk
    }

    #[inline(always)]
    unsafe fn dealloc_small(&self, p: *mut u8, c: usize) {
        let s = &mut *self.0.get();
        *(p as *mut *mut u8) = s.free[c];
        s.free[c] = p;
    }
}

unsafe impl GlobalAlloc for Alloc {
    #[inline]
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        match class(layout.size(), layout.align()) {
            Some(c) => self.alloc_small(c),
            None => System.alloc(layout),
        }
    }

    #[inline]
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        match class(layout.size(), layout.align()) {
            Some(c) => {
                let p = self.alloc_small(c);
                if !p.is_null() {
                    ptr::write_bytes(p, 0, layout.size());
                }
                p
            }
            None => System.alloc_zeroed(layout),
        }
    }

    #[inline]
    unsafe fn dealloc(&self, p: *mut u8, layout: Layout) {
        match class(layout.size(), layout.align()) {
            Some(c) => self.dealloc_small(p, c),
            None => System.dealloc(p, layout),
        }
    }

    #[inline]
    unsafe fn realloc(&self, p: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let old = class(layout.size(), layout.align());
        let new = class(new_size, layout.align());
        match (old, new) {
            (None, None) => System.realloc(p, layout, new_size),
            (Some(a), Some(b)) if a == b => p,
            _ => {
                let new_layout = Layout::from_size_align_unchecked(new_size, layout.align());
                let q = self.alloc(new_layout);
                if !q.is_null() {
                    ptr::copy_nonoverlapping(p, q, layout.size().min(new_size));
                    self.dealloc(p, layout);
                }
                q
            }
        }
    }
}
