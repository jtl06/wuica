//! The issue log (not in the reference): per cycle, how many fused uops the renamer issued and, if fewer than the issue width,
//! why. Recorded only by [`super::simulate_with_issue_log`]; it reads the state of the simulation and changes nothing, so the
//! results of a simulation with and without it are the same.
//!
//! The cause of a cycle with fewer than `issueWidth` issued uops, in the order in which the simulation checks it:
//! - `R`: the reorder buffer was full (`ReorderBuffer.isFull`: nothing is issued);
//! - `S`: the scheduler (reservation station) was full (`Scheduler.isFull`: nothing is issued);
//! - `F`: the front end did not deliver enough: the IDQ ran empty;
//! - `O`: other: the next uop did not fit into the cycle (its fused uops), a serializing instruction waited for the reorder
//!   buffer to drain, or register merge uops were inserted.

use super::Sim;

pub const FULL: u8 = b'.';
pub const ROB_FULL: u8 = b'R';
pub const RS_FULL: u8 = b'S';
pub const FRONT_END: u8 = b'F';
pub const OTHER: u8 = b'O';

/// The issue log of a simulation.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct IssueLog {
    /// `issueWidth`
    pub width: i64,
    /// per cycle (index = clock): the number of fused uops issued
    pub issued: Vec<u8>,
    /// per cycle: [`FULL`] or the cause of the lost issue slots
    pub cause: Vec<u8>,
    /// the steady-state window: cycles `first_cycle + 1 ..= last_cycle` issue the uops of the rounds `first_round + 1 ..=
    /// last_round` (the round's last uop of the last decoded instruction ends a round, as for the throughput)
    pub first_cycle: i64,
    pub last_cycle: i64,
    pub first_round: i64,
    pub last_round: i64,
}

impl Sim<'_> {
    /// records the cycle just issued (`issue_uops`: the fused uops issued in this cycle)
    pub(crate) fn log_issue(&mut self, n_issued: usize) {
        // the renamer does not change the reorder buffer or the scheduler, so their state is the one that was checked
        let width = self.cfg.issue_width;
        let cause = if n_issued as i64 >= width {
            FULL
        } else if n_issued == 0 && self.rob_is_full() {
            ROB_FULL
        } else if n_issued == 0 && self.scheduler_is_full() {
            RS_FULL
        } else if self.idq.is_empty() {
            FRONT_END
        } else {
            OTHER
        };
        if let Some(log) = self.issue_log.as_mut() {
            log.issued.push(n_issued.min(u8::MAX as usize) as u8);
            log.cause.push(cause);
        }
    }
}
