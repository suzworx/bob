// Bob Cardputer v2 — the uplink queue and its per-loop send budget (pure
// logic, no I/O).
//
// Every framed audio_up frame of a turn goes into one bounded FIFO (the frame
// bytes live in a heap buffer the caller owns; this keeps the slot indexes),
// and each main-loop pass sends from its head within a budget. A socket that
// is busy (the network task holds the client, or lwIP's send buffer is full)
// leaves frames queued, in order, for the next pass: nothing is skipped, so
// the server never sees a sequence gap, and the loop never waits on the socket
// for long. HIL run 20260924-165003-c15f: each blocked send took 20-40 ms, the
// capture loop took frames faster than it could send them and never returned
// (loop_slow 1026 ms and 13368 ms), and the frames sendBinary gave up on
// became SEQUENCE_GAP errors.
//
// The same FIFO holds a GO press's frames until the hold qualifies and the
// follow-up window's pre-roll (the newest frames, dropOldest()).
#pragma once

#include <cstddef>
#include <cstdint>
#include <cstring>

#include "config.h"

namespace bob {

// 1.6 s of 10 ms frames (160 x 340 B = 54,400 B heap while a turn is open,
// plus the 2,580 B batch, kUplinkBatchBytes, in the same block).
// Full means the socket has taken nothing for about that long: the turn ends
// cleanly with what was queued (end_reason=uplink). HIL run
// 20260924-195519-54b4 measured the socket's worst normal stalls: a lost TCP
// segment waits for lwIP's retransmission timeout, 1.0-1.33 s with nothing
// reaching the server (its own frame arrival gaps match the device's), while
// the 5,744 B send buffer holds only ~170 ms of audio. 1.6 s rides those out;
// a longer outage (one run: 5.9 s) still ends the turn cleanly.
constexpr size_t kUplinkQueueFrames = 160;
// Batching (docs/voice-latency-rca.md #1): one 10 ms frame per WebSocket
// message over TLS was slower than real time, so the drain after the mic
// closed took 1.0-3.0 s. Consecutive queued frames now go as one audio_up
// (one header, the PCM payloads in order, the sequence counting messages):
// at least 40 ms while capturing, at most 80 ms. 80 ms is 2,580 B, plus 8 B of
// WebSocket header and two 29 B TLS records, under lwIP's TCP_SNDLOWAT
// (2,873 B of the 5,744 B send buffer): a socket that selects writable takes
// a whole batch without blocking (2026-09-24: a ~6 KB burst blocked the loop
// 0.2-10 s). The server takes up to 4,096 B of payload (AUDIO_PAYLOAD_LIMIT_BYTES).
constexpr size_t kUplinkBatchMinFrames = 4;
constexpr size_t kUplinkBatchMaxFrames = 8;
constexpr size_t kUplinkFramePcmBytes = config::kSamplesPerFrame * sizeof(int16_t);
constexpr size_t kUplinkBatchBytes = config::kHeaderBytes + kUplinkBatchMaxFrames * kUplinkFramePcmBytes;
static_assert(kUplinkBatchMaxFrames * kUplinkFramePcmBytes <= 4096, "AUDIO_PAYLOAD_LIMIT_BYTES");
// While capturing, a pass may send the frames it captured plus one batch of
// older ones, so a backlog clears at ~8 frames per pass.
constexpr size_t kUplinkCatchUpPerLoop = kUplinkBatchMaxFrames;
// After the mic closed, a pass sends the whole queue (the loop budget and a
// busy socket still stop it); turn_end follows the last frame.
constexpr size_t kUplinkDrainPerLoop = kUplinkQueueFrames;
// A pass stops sending once it has spent this long in the socket.
constexpr uint32_t kUplinkLoopBudgetMs = 30;
// A queue that will not drain after the turn ended is given up on: the rest is
// discarded (the tail only, so still no gap) and turn_end names the last frame sent.
constexpr uint32_t kUplinkDrainTimeoutMs = 3000;

class UplinkQueue {
 public:
  explicit UplinkQueue(size_t capacity) : capacity_(capacity) {}

  // The slot for the next frame (the caller copies the frame there), or false
  // when full. A full queue never overwrites.
  bool push(size_t* slot) {
    if (full()) return false;
    *slot = (head_ + count_) % capacity_;
    ++count_;
    return true;
  }

  // The i-th oldest frame's slot (0 = the next to send).
  size_t slotAt(size_t i) const { return (head_ + i) % capacity_; }

  void pop() {
    if (count_ == 0) return;
    head_ = (head_ + 1) % capacity_;
    --count_;
  }
  void dropOldest() { pop(); }
  void clear() {
    head_ = 0;
    count_ = 0;
  }

  size_t size() const { return count_; }
  size_t capacity() const { return capacity_; }
  bool empty() const { return count_ == 0; }
  bool full() const { return count_ == capacity_; }

 private:
  size_t capacity_;
  size_t head_ = 0;
  size_t count_ = 0;
};

// Frames this pass may send: `liveTaken` captured this pass plus the
// catch-up while capturing, or a drain batch once the mic has closed.
inline size_t uplinkAllowance(size_t liveTaken, bool ending) {
  return ending ? kUplinkDrainPerLoop : liveTaken + kUplinkCatchUpPerLoop;
}

// Frames for the next message: up to a batch within what the pass may still
// send; while capturing, none until 40 ms are queued (they wait for the next
// pass), once the mic has closed any tail goes.
inline size_t uplinkBatchFrames(size_t queued, size_t allowanceLeft, bool ending) {
  size_t n = queued < allowanceLeft ? queued : allowanceLeft;
  if (n > kUplinkBatchMaxFrames) n = kUplinkBatchMaxFrames;
  return !ending && n < kUplinkBatchMinFrames ? 0 : n;
}

// Packs `n` framed 10 ms frames (frameAt(i): the i-th, header included) into
// one audio_up at `out` (kUplinkBatchBytes): the first frame's header with
// `sequence` (the message's index in the turn, big-endian like the server
// reads it) and the summed payload length, then the payloads. Returns its bytes.
template <typename FrameAt>
size_t packUplinkBatch(FrameAt frameAt, size_t n, uint32_t sequence, uint8_t* out) {
  const auto be32 = [](uint8_t* at, uint32_t v) {
    at[0] = static_cast<uint8_t>(v >> 24);
    at[1] = static_cast<uint8_t>(v >> 16);
    at[2] = static_cast<uint8_t>(v >> 8);
    at[3] = static_cast<uint8_t>(v);
  };
  std::memcpy(out, frameAt(0), config::kHeaderBytes);
  be32(out + 12, sequence);
  be32(out + 16, static_cast<uint32_t>(n * kUplinkFramePcmBytes));
  for (size_t i = 0; i < n; ++i) {
    std::memcpy(out + config::kHeaderBytes + i * kUplinkFramePcmBytes, frameAt(i) + config::kHeaderBytes,
                kUplinkFramePcmBytes);
  }
  return config::kHeaderBytes + n * kUplinkFramePcmBytes;
}

// Whether a pass that has sent `sent` frames in `elapsedMs` may try another.
inline bool uplinkMaySend(size_t sent, size_t allowance, uint32_t elapsedMs) {
  return sent < allowance && elapsedMs < kUplinkLoopBudgetMs;
}

// True once kUplinkDrainTimeoutMs have passed since the turn ended (wrap safe).
inline bool uplinkDrainExpired(uint32_t endedAtMs, uint32_t nowMs) {
  return nowMs - endedAtMs >= kUplinkDrainTimeoutMs;
}

// Socket back-pressure, measured (HIL: turn_ended tx_busy, tx_busy_max_ms). A
// write is refused while the TCP send buffer has no room (the socket is not
// writable); a streak runs from the first refused write to the next accepted
// one, so its length is how long the socket took nothing.
class TxBusyTracker {
 public:
  void refused(uint32_t nowMs) {
    ++count_;
    if (!open_) {
      open_ = true;
      since_ = nowMs;
      ++streaks_;
    }
  }
  void sent(uint32_t nowMs) {
    if (!open_) return;
    open_ = false;
    if (nowMs - since_ > maxMs_) maxMs_ = nowMs - since_;
  }
  void reset() { *this = TxBusyTracker(); }

  uint32_t count() const { return count_; }      // refused writes.
  uint32_t streaks() const { return streaks_; }
  uint32_t maxMs() const { return maxMs_; }       // longest closed streak.
  uint32_t openMs(uint32_t nowMs) const { return open_ ? nowMs - since_ : 0; }
  uint32_t maxMsIncludingOpen(uint32_t nowMs) const {
    return openMs(nowMs) > maxMs_ ? openMs(nowMs) : maxMs_;
  }

 private:
  uint32_t count_ = 0;
  uint32_t streaks_ = 0;
  uint32_t maxMs_ = 0;
  uint32_t since_ = 0;
  bool open_ = false;
};

}  // namespace bob
