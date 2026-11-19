// The capture frame ring (include/frame_ring.h): the mic is given buffers in
// order, at most two in flight (M5Unified's two record() slots), a frame is
// handed out only after the mic filled it, and a full ring stops queueing
// instead of overwriting a frame nobody has read yet.
#include <cstdint>
#include <deque>
#include <vector>

#include "audio_capture.h"
#include "audio_capture_rate.h"
#include "doctest.h"
#include "frame_ring.h"

namespace {
constexpr size_t kSamples = 4;
using Ring = bob::FrameRing<4, kSamples>;
}  // namespace

TEST_CASE("an empty ring hands out nothing to read") {
  int16_t storage[4 * kSamples] = {};
  Ring ring(storage);
  CHECK(ring.peek() == nullptr);
  CHECK(ring.inFlight() == 0);
}

TEST_CASE("at most two buffers are queued with the mic at once") {
  int16_t storage[4 * kSamples] = {};
  Ring ring(storage);
  CHECK(ring.claimForQueue() == storage);
  CHECK(ring.claimForQueue() == storage + kSamples);
  CHECK(ring.claimForQueue() == nullptr);
  CHECK(ring.inFlight() == 2);
}

TEST_CASE("a queued buffer is not readable until the mic has filled it") {
  int16_t storage[4 * kSamples] = {};
  Ring ring(storage);
  int16_t* first = ring.claimForQueue();
  CHECK(ring.peek() == nullptr);
  first[0] = 42;
  CHECK(ring.markFilled(first));
  REQUIRE(ring.peek() == first);
  CHECK(ring.peek()[0] == 42);
  ring.pop();
  CHECK(ring.peek() == nullptr);
}

TEST_CASE("frames come out in the order they were queued") {
  int16_t storage[4 * kSamples] = {};
  Ring ring(storage);
  int16_t* a = ring.claimForQueue();
  int16_t* b = ring.claimForQueue();
  CHECK(ring.markFilled(a));
  CHECK(ring.markFilled(b));
  CHECK(ring.peek() == a);
  ring.pop();
  CHECK(ring.peek() == b);
}

TEST_CASE("a filled slot frees the mic for the next buffer") {
  int16_t storage[4 * kSamples] = {};
  Ring ring(storage);
  int16_t* a = ring.claimForQueue();
  ring.claimForQueue();
  CHECK(ring.markFilled(a));
  CHECK(ring.claimForQueue() == storage + 2 * kSamples);
}

TEST_CASE("a full ring stops queueing until the reader frees a frame") {
  int16_t storage[4 * kSamples] = {};
  Ring ring(storage);
  for (int i = 0; i < 4; ++i) {
    int16_t* p = ring.claimForQueue();
    REQUIRE(p != nullptr);
    CHECK(ring.markFilled(p));
  }
  CHECK(ring.claimForQueue() == nullptr);  // every slot holds an unread frame.
  ring.pop();
  CHECK(ring.claimForQueue() == storage);  // the oldest slot is reused.
}

TEST_CASE("a release for a buffer that is not the oldest in flight is refused") {
  int16_t storage[4 * kSamples] = {};
  Ring ring(storage);
  ring.claimForQueue();
  int16_t* b = ring.claimForQueue();
  CHECK_FALSE(ring.markFilled(b));
  CHECK(ring.peek() == nullptr);
}

TEST_CASE("an unclaim gives back a buffer the mic refused") {
  int16_t storage[4 * kSamples] = {};
  Ring ring(storage);
  int16_t* a = ring.claimForQueue();
  ring.unclaim();
  CHECK(ring.inFlight() == 0);
  CHECK(ring.claimForQueue() == a);
}

TEST_CASE("the counters survive wrapping past 2^32") {
  int16_t storage[4 * kSamples] = {};
  Ring ring(storage, UINT32_MAX - 1);
  for (int i = 0; i < 10; ++i) {
    int16_t* p = ring.claimForQueue();
    REQUIRE(p != nullptr);
    CHECK(ring.markFilled(p));
    REQUIRE(ring.peek() == p);
    ring.pop();
  }
  CHECK(ring.inFlight() == 0);
}

// WS185-MIC-RING. HIL wake-capture-rate on the Waveshare read 71-94 fps (want 97-103): a LISTEN loop
// pass takes 111-121 ms, but an 8-frame ring is only 80 ms of slack, so M5's mic_task ran out of
// queued buffers and dropped audio. MicSim plays the mic against a real ring: every 10 ms tick it
// fills the oldest buffer it holds (its own FIFO, like M5's two record() slots), stamps the tick in
// sample[0] and re-queues; with nothing queued that tick's audio is lost. The consumer drains on its
// own schedule, then tops the mic up as the main loop does.
namespace {

template <size_t N>
struct MicSim {
  std::vector<int16_t> storage = std::vector<int16_t>(N * kSamples);
  bob::FrameRing<N, kSamples> ring{storage.data()};
  std::deque<int16_t*> claimed;  // queued with the mic, oldest first.
  std::vector<int> received;     // sample[0] of every frame the consumer took, in order.
  uint32_t lost = 0;
  int tick = 0;

  MicSim() { topUp(); }

  void topUp() {
    while (int16_t* p = ring.claimForQueue()) claimed.push_back(p);
    REQUIRE(claimed.size() <= 2);
  }

  void micTick() {
    if (claimed.empty()) {
      ++lost;
    } else {
      int16_t* p = claimed.front();
      claimed.pop_front();
      p[0] = static_cast<int16_t>(tick);
      REQUIRE(ring.markFilled(p));
      topUp();
    }
    ++tick;
  }

  void drain() {
    while (const int16_t* f = ring.peek()) {
      received.push_back(f[0]);
      ring.pop();
    }
    topUp();
  }

  // Runs `ticks` mic ticks; the consumer drains after every `every`-th tick (counted from tick 0).
  void run(int ticks, int every) {
    for (int i = 0; i < ticks; ++i) {
      const int now = tick;
      micTick();
      if ((now + 1) % every == 0) drain();
    }
  }
};

void checkContiguousFrom(const std::vector<int>& got, int first) {
  for (size_t i = 0; i < got.size(); ++i) REQUIRE(got[i] == first + static_cast<int>(i));
}

}  // namespace

TEST_CASE("mic ring: the per-board ring sizes are 64 frames on the Waveshare and 8 on the Cardputer") {
  CHECK(bob::kCaptureRingFramesWaveshare == 64);
  CHECK(bob::kCaptureRingFramesCardputer == 8);
  // The host build defines no board, so it keeps the Cardputer value.
  CHECK(bob::kCaptureRingFrames == bob::kCaptureRingFramesCardputer);
}

TEST_CASE("mic ring: a 64-frame ring rides out a 250 ms loop stall without losing audio") {
  MicSim<bob::kCaptureRingFramesWaveshare> sim;
  sim.run(50, 1);   // 500 ms of a fast loop.
  sim.run(25, 25);  // one 250 ms pass, drained at its end.
  sim.run(50, 1);
  CHECK(sim.lost == 0);
  CHECK(sim.received.size() == 125);
  checkContiguousFrom(sim.received, 0);
}

TEST_CASE("mic ring: a 64-frame ring keeps every frame with a 120 ms loop pass for 3 s") {
  MicSim<bob::kCaptureRingFramesWaveshare> sim;
  sim.run(300, 12);
  CHECK(sim.lost == 0);
  CHECK(sim.received.size() == 300);
  checkContiguousFrom(sim.received, 0);
}

TEST_CASE("mic ring: today's 8-frame Cardputer ring loses audio with a 120 ms loop pass") {
  MicSim<bob::kCaptureRingFramesCardputer> sim;
  sim.run(300, 12);
  CHECK(sim.lost > 0);
  CHECK(sim.received.size() + sim.lost == 300);
  for (size_t i = 1; i < sim.received.size(); ++i) REQUIRE(sim.received[i] > sim.received[i - 1]);
}

TEST_CASE("mic ring: an 800 ms stall keeps the oldest 64 frames, counts the rest lost, then resumes") {
  MicSim<bob::kCaptureRingFramesWaveshare> sim;
  for (int i = 0; i < 81; ++i) sim.micTick();  // ticks 0..80, nobody reads.
  // No unread slot was overwritten: slot i still holds tick i.
  for (int i = 0; i < 64; ++i) REQUIRE(sim.storage[static_cast<size_t>(i) * kSamples] == i);
  CHECK(sim.ring.ready() == 64);
  CHECK(sim.lost == 17);  // ticks 64..80 found no buffer queued.
  sim.drain();
  CHECK(sim.received.size() == 64);
  checkContiguousFrom(sim.received, 0);
  sim.received.clear();
  sim.run(20, 1);  // ticks 81..100, a fast loop again.
  CHECK(sim.lost == 17);
  CHECK(sim.received.size() == 20);
  checkContiguousFrom(sim.received, 81);
}

TEST_CASE("mic ring: ready() counts filled, unread frames only") {
  int16_t storage[4 * kSamples] = {};
  Ring ring(storage);
  CHECK(ring.ready() == 0);
  int16_t* a = ring.claimForQueue();
  int16_t* b = ring.claimForQueue();
  CHECK(ring.ready() == 0);  // queued with the mic, not filled yet.
  CHECK(ring.markFilled(a));
  CHECK(ring.ready() == 1);
  CHECK(ring.markFilled(b));
  CHECK(ring.ready() == 2);
  CHECK(ring.peek() == a);
  CHECK(ring.ready() == 2);  // peek does not consume.
  ring.pop();
  CHECK(ring.ready() == 1);
  ring.pop();
  CHECK(ring.ready() == 0);
}

TEST_CASE("mic ring: ready() stays right across the 2^32 counter wrap") {
  int16_t storage[4 * kSamples] = {};
  Ring ring(storage, UINT32_MAX - 1);
  for (int i = 0; i < 4; ++i) {  // filled goes UINT32_MAX-1 -> 2; read stays at UINT32_MAX-1.
    int16_t* p = ring.claimForQueue();
    REQUIRE(p != nullptr);
    CHECK(ring.markFilled(p));
    CHECK(ring.ready() == static_cast<uint32_t>(i + 1));
  }
  ring.pop();
  ring.pop();
  ring.pop();  // read is now 1, past the wrap.
  CHECK(ring.ready() == 1);
  int16_t* p = ring.claimForQueue();
  REQUIRE(p != nullptr);
  CHECK(ring.ready() == 1);  // queued, unfilled.
  CHECK(ring.markFilled(p));
  CHECK(ring.ready() == 2);
}

// WS185-MIC-RING c1: fps counts the frames the mic delivered, from the time of the first one. On the
// Waveshare the first take can come ~100 ms after the first fill (begin() and the LISTENING redraw share
// one slow pass), so the start is backdated by the frames already waiting.
TEST_CASE("capture rate: a slow first pass starts at the backdated first fill") {
  // First frame filled at t=0; first take at t=100 with 10 frames waiting (filled at 0..90).
  const uint32_t start = bob::captureStartMs(100, 10, 10);
  CHECK(start == 10);
  // A 1.7 s turn: 170 frames delivered, the one in hand still unread in the ring.
  const uint32_t fps = bob::captureFramesPerSecond(170, 1, true, start, 1700);
  CHECK(fps >= 97);
  CHECK(fps <= 103);
}

TEST_CASE("capture rate: a steady start reads 97-103 fps for a 1.7 s turn") {
  const uint32_t start = bob::captureStartMs(0, 1, 10);
  CHECK(start == 0);
  const uint32_t fps = bob::captureFramesPerSecond(170, 1, true, start, 1700);
  CHECK(fps >= 97);
  CHECK(fps <= 103);
}

TEST_CASE("capture rate: frames still waiting in the ring count as delivered") {
  // 5 taken, 3 waiting unread, none in hand: 8 delivered, 7 intervals over 700 ms = 10 per s.
  CHECK(bob::captureFramesPerSecond(5, 3, false, 0, 700) == 10);
}

TEST_CASE("capture rate: fewer than two frames read 0 fps") {
  CHECK(bob::captureFramesPerSecond(0, 0, false, 0, 1000) == 0);
  CHECK(bob::captureFramesPerSecond(1, 5, true, 0, 1000) == 0);
}
