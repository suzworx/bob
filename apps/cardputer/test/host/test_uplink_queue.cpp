// The uplink queue and its per-loop send budget (include/uplink_queue.h).
// HIL run 20260924-165003-c15f: a busy socket made every send wait 20-40 ms,
// the capture loop never caught up (loop_slow 1026 ms and 13368 ms), and the
// frames sendBinary gave up on became server SEQUENCE_GAPs.
#include <cstddef>
#include <cstdint>
#include <vector>

#include "doctest.h"
#include "uplink_queue.h"

using bob::UplinkQueue;

TEST_CASE("the bounds") {
  // 1.6 s: covers the ~1.0-1.33 s TCP retransmission stalls of HIL run
  // 20260924-195519-54b4 without ending the turn.
  CHECK(bob::kUplinkQueueFrames == 160);
  CHECK(bob::kUplinkCatchUpPerLoop == bob::kUplinkBatchMaxFrames);
  CHECK(bob::kUplinkDrainPerLoop == bob::kUplinkQueueFrames);  // the time budget bounds a drain pass.
  CHECK(bob::kUplinkLoopBudgetMs == 30);
  CHECK(bob::kUplinkDrainTimeoutMs == 3000);
}

TEST_CASE("frames come out in the order they went in, across the slot wrap") {
  UplinkQueue q(4);
  std::vector<size_t> order;
  size_t slot = 0;
  for (int i = 0; i < 3; ++i) REQUIRE(q.push(&slot));
  q.pop();
  q.pop();
  REQUIRE(q.push(&slot));
  REQUIRE(q.push(&slot));
  REQUIRE(q.push(&slot));
  CHECK(q.full());
  CHECK_FALSE(q.push(&slot));  // full: refused, nothing overwritten.
  CHECK(q.size() == 4);
  for (size_t i = 0; i < q.size(); ++i) order.push_back(q.slotAt(i));
  CHECK(order == std::vector<size_t>{2, 3, 0, 1});
  q.pop();
  CHECK(q.slotAt(0) == 3);
  q.clear();
  CHECK(q.empty());
}

TEST_CASE("dropOldest keeps the newest frames (the follow-up pre-roll)") {
  UplinkQueue q(4);
  size_t slot = 0;
  for (int i = 0; i < 3; ++i) REQUIRE(q.push(&slot));
  q.dropOldest();
  CHECK(q.size() == 2);
  CHECK(q.slotAt(0) == 1);
}

TEST_CASE("the per-loop allowance: live frames plus one batch while capturing, the whole queue after") {
  CHECK(bob::uplinkAllowance(1, false) == 9);
  CHECK(bob::uplinkAllowance(3, false) == 11);
  CHECK(bob::uplinkAllowance(0, true) == 160);
}

// --- Batched uplink (docs/voice-latency-rca.md #1): one 10 ms frame per
// WebSocket message over TLS is slower than real time, so the drain after the
// mic closed took 1.0-3.0 s. Several queued frames now go in one audio_up. ---

TEST_CASE("a batch is 40-80 ms: inside the server's 4,096 B payload and lwIP's writable mark") {
  CHECK(bob::kUplinkBatchMinFrames == 4);
  CHECK(bob::kUplinkBatchMaxFrames == 8);
  CHECK(bob::kUplinkBatchMaxFrames * 320 <= 4096);  // AUDIO_PAYLOAD_LIMIT_BYTES (apps/api protocol.ts).
  // 20 B header + 2,560 B PCM + 8 B WebSocket header + two 29 B TLS records:
  // under lwIP's TCP_SNDLOWAT (2,873 B of the 5,744 B send buffer), so a
  // socket that selects writable takes the whole batch without blocking.
  CHECK(bob::kUplinkBatchBytes == 2580);
  CHECK(bob::kUplinkBatchBytes + 8 + 2 * 29 < 2873);
}

TEST_CASE("while capturing a batch waits for 40 ms of audio; after, any tail goes") {
  CHECK(bob::uplinkBatchFrames(3, 9, false) == 0);
  CHECK(bob::uplinkBatchFrames(4, 9, false) == 4);
  CHECK(bob::uplinkBatchFrames(30, 9, false) == 8);
  CHECK(bob::uplinkBatchFrames(30, 3, false) == 0);  // the pass's allowance is nearly spent.
  CHECK(bob::uplinkBatchFrames(3, 160, true) == 3);
  CHECK(bob::uplinkBatchFrames(1, 160, true) == 1);
  CHECK(bob::uplinkBatchFrames(0, 160, true) == 0);
}

TEST_CASE("a packed batch is one audio_up: the message's sequence and the payloads in order") {
  uint8_t frames[3][340] = {};
  for (int f = 0; f < 3; ++f) {
    const uint8_t header[20] = {'O', 'L', 'X', '2', 2, 1, 1, 1, 0, 0, 0, 1,
                                0, 0, 0, static_cast<uint8_t>(7 + f), 0, 0, 1, 64};
    for (int i = 0; i < 20; ++i) frames[f][i] = header[i];
    for (int i = 20; i < 340; ++i) frames[f][i] = static_cast<uint8_t>(f * 100 + i % 97);
  }
  uint8_t out[bob::kUplinkBatchBytes] = {};
  const size_t bytes = bob::packUplinkBatch([&](size_t i) { return frames[i]; }, 3, 0x01020304u, out);
  CHECK(bytes == 20 + 960);
  for (int i = 0; i < 12; ++i) CHECK(out[i] == frames[0][i]);  // magic, version, kind, format, channels, handle.
  CHECK(out[12] == 1);  // sequence, big-endian: the message index, not the frame's own.
  CHECK(out[13] == 2);
  CHECK(out[14] == 3);
  CHECK(out[15] == 4);
  CHECK(out[16] == 0);  // payload bytes, big-endian: 960.
  CHECK(out[17] == 0);
  CHECK(out[18] == 0x03);
  CHECK(out[19] == 0xC0);
  for (int f = 0; f < 3; ++f)
    for (int i = 0; i < 320; ++i) CHECK(out[20 + f * 320 + i] == frames[f][20 + i]);
}

TEST_CASE("a 1 s backlog drains in 13 messages in one pass, not 25 passes of 4 frames") {
  UplinkQueue q(bob::kUplinkQueueFrames);
  size_t slot = 0;
  for (int i = 0; i < 100; ++i) REQUIRE(q.push(&slot));
  const size_t allowance = bob::uplinkAllowance(0, true);
  std::vector<size_t> messages;
  for (size_t sent = 0; bob::uplinkMaySend(sent, allowance, 0);) {
    const size_t n = bob::uplinkBatchFrames(q.size(), allowance - sent, true);
    if (n == 0) break;
    for (size_t i = 0; i < n; ++i) q.pop();
    sent += n;
    messages.push_back(n);
  }
  CHECK(q.empty());
  CHECK(messages == std::vector<size_t>{8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 4});
}

TEST_CASE("a loop stops sending at its allowance or its time budget") {
  CHECK(bob::uplinkMaySend(0, 3, 0));
  CHECK_FALSE(bob::uplinkMaySend(3, 3, 0));
  CHECK(bob::uplinkMaySend(1, 3, 29));
  CHECK_FALSE(bob::uplinkMaySend(1, 3, 30));
}

TEST_CASE("the drain gives up 3 s after the turn ended, across the millis wrap") {
  CHECK_FALSE(bob::uplinkDrainExpired(0xFFFFFF00u, 0x00000AB7u));  // 2999 ms.
  CHECK(bob::uplinkDrainExpired(0xFFFFFF00u, 0x00000AB8u));        // 3000 ms.
}

namespace {

// 10 ms loops at 100 frames/s: one live frame per loop. Sends fail while the
// socket is busy (stallFrom..stallTo, loop indexes). Returns the frames sent,
// in order, or stops at the first overflow.
struct Sim {
  std::vector<uint32_t> sent;
  std::vector<size_t> messages;  // frames per audio_up message.
  bool overflow = false;
  size_t maxQueued = 0;
};

Sim simulate(size_t loops, size_t stallFrom, size_t stallTo) {
  UplinkQueue q(bob::kUplinkQueueFrames);
  std::vector<uint32_t> slots(bob::kUplinkQueueFrames);
  Sim sim;
  uint32_t seq = 0;
  // One pass: batches within the allowance, as pumpUplink sends them.
  const auto pass = [&](size_t liveTaken, bool ending, bool busy) {
    const size_t allowance = bob::uplinkAllowance(liveTaken, ending);
    for (size_t n = 0; bob::uplinkMaySend(n, allowance, 0);) {
      const size_t batch = bob::uplinkBatchFrames(q.size(), allowance - n, ending);
      if (batch == 0 || busy) break;  // busy: the send would block, the batch stays queued.
      for (size_t i = 0; i < batch; ++i) {
        sim.sent.push_back(slots[q.slotAt(0)]);
        q.pop();
      }
      sim.messages.push_back(batch);
      n += batch;
    }
  };
  for (size_t loop = 0; loop < loops && !sim.overflow; ++loop) {
    size_t slot = 0;
    if (!q.push(&slot)) {
      sim.overflow = true;
      break;
    }
    slots[slot] = seq++;
    if (q.size() > sim.maxQueued) sim.maxQueued = q.size();
    pass(1, false, loop >= stallFrom && loop < stallTo);
  }
  if (!sim.overflow) pass(0, true, false);  // the mic closed: the tail goes.
  return sim;
}

}  // namespace

TEST_CASE("a 500 ms socket stall loses nothing and the backlog clears in order") {
  const Sim sim = simulate(200, 50, 100);
  CHECK_FALSE(sim.overflow);
  // 2 frames waiting for a batch + 50 stalled + the next loop's, before it sends.
  CHECK(sim.maxQueued == 53);
  REQUIRE(sim.sent.size() == 200);
  for (uint32_t i = 0; i < sim.sent.size(); ++i) CHECK(sim.sent[i] == i);
  // Every message while capturing carried 40-80 ms; only the tail is shorter.
  for (size_t m = 0; m + 1 < sim.messages.size(); ++m) {
    CHECK(sim.messages[m] >= bob::kUplinkBatchMinFrames);
    CHECK(sim.messages[m] <= bob::kUplinkBatchMaxFrames);
  }
  CHECK(sim.messages.size() < 200 / bob::kUplinkBatchMinFrames + 2);
}

TEST_CASE("a stall longer than the queue overflows instead of skipping frames") {
  const Sim sim = simulate(400, 10, 300);
  CHECK(sim.overflow);
  // Everything that did go out is contiguous from 0: no sequence gap.
  for (uint32_t i = 0; i < sim.sent.size(); ++i) CHECK(sim.sent[i] == i);
}

// --- c7: socket back-pressure, measured instead of blocked on ---

TEST_CASE("a busy streak runs from the first refused write to the next accepted one") {
  bob::TxBusyTracker busy;
  busy.sent(1000);                 // nothing pending: no streak.
  CHECK(busy.count() == 0);
  CHECK(busy.maxMs() == 0);
  busy.refused(2000);
  busy.refused(2010);              // the same streak.
  busy.refused(2500);
  busy.sent(3117);                 // 1117 ms without room in the send buffer.
  CHECK(busy.count() == 3);
  CHECK(busy.streaks() == 1);
  CHECK(busy.maxMs() == 1117);
  busy.refused(4000);
  busy.sent(4300);
  CHECK(busy.streaks() == 2);
  CHECK(busy.maxMs() == 1117);     // the longest one stays.
  busy.reset();
  CHECK(busy.count() == 0);
  CHECK(busy.maxMs() == 0);
}

TEST_CASE("a streak still open is counted up to now, across the millis wrap") {
  bob::TxBusyTracker busy;
  busy.refused(0xFFFFFF00u);
  CHECK(busy.openMs(0x00000100u) == 512);
  CHECK(busy.maxMsIncludingOpen(0x00000100u) == 512);
}

TEST_CASE("a 1.3 s stall with no writes fits the queue: the turn goes on") {
  const Sim sim = simulate(400, 50, 183);  // 133 loops = 1.33 s without room.
  CHECK_FALSE(sim.overflow);
  CHECK(sim.sent.size() == 400);
}
