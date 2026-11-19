// The PCM downlink ring (src/mp3_ring_source.h, PcmRing) against issue #674
// (HIL run 20260929-110910-342e, pcm-reply): beginPlayback(kPcm16) asked for
// one 320 KB internal block for the whole reply, then 160 KB; the largest free
// block is 159732 B in every mode, so both failed (playback_buffer_failed) and
// ~12 s of frames were discarded. The ring streams instead: a reply of any
// length plays through a bounded buffer the speaker drains as it goes.
#include <cstring>
#include <vector>

#include "doctest.h"
#include "../../src/mp3_ring_source.h"

namespace {

constexpr size_t kRing = 48 * 1024;       // config::kPcmRingBufferBytes
constexpr size_t kPrebuffer = 16 * 1024;  // config::kPcmPrebufferBytes
constexpr size_t kChunk = 2048;           // config::kPcmChunkSamples
constexpr size_t kFrameBytes = 320;       // DOWNLINK_FRAME_BYTES: 10 ms of PCM16
constexpr size_t kReplyBytes = 12 * 32000;  // ~12 s, the reply #674 dropped

struct Played {
  size_t samples = 0;
  bool inOrder = true;
};

// A 10 ms tick loop: the producer pushes `framesPerTick(tick)` frames, the
// speaker (two queue slots, like M5's playRaw) plays 160 samples, and the pump
// feeds it whenever a slot is free, as AudioPlayback::pumpPcm() does.
template <typename FramesPerTick>
Played play(bob::PcmRing& ring, size_t replyBytes, FramesPerTick framesPerTick) {
  Played out;
  std::vector<int16_t> chunk(kChunk);
  size_t queued[2] = {0, 0};
  size_t inFlight = 0;
  size_t sent = 0;
  int16_t next = 0;
  int16_t expect = 0;
  for (int tick = 0; tick < 100000; ++tick) {
    for (int f = framesPerTick(tick); f > 0 && sent < replyBytes; --f) {
      int16_t frame[kFrameBytes / 2];
      for (auto& s : frame) s = next++;
      ring.push(reinterpret_cast<const uint8_t*>(frame), kFrameBytes);
      sent += kFrameBytes;
    }
    const bool ended = sent >= replyBytes;
    size_t budget = 160;
    while (budget > 0 && inFlight > 0) {
      const size_t n = queued[0] < budget ? queued[0] : budget;
      queued[0] -= n;
      budget -= n;
      if (queued[0] == 0) queued[0] = queued[1], queued[1] = 0, --inFlight;
    }
    while (inFlight < 2) {
      const size_t n = ring.take(chunk.data(), kChunk, ended, inFlight == 0);
      if (n == 0) break;
      for (size_t i = 0; i < n; ++i) out.inOrder &= chunk[i] == expect++;
      out.samples += n;
      queued[inFlight++] = n;
    }
    if (ended && inFlight == 0 && ring.available() == 0) break;
  }
  return out;
}

}  // namespace

TEST_CASE("the old whole-reply buffer never fit the measured heap") {
  // heap-per-mode: largest free block 159732 B in ptt, wake and announce_only.
  constexpr size_t kLargestBlock = 159732;
  CHECK(320 * 1024 > kLargestBlock);      // the removed kPlaybackBufferBytes
  CHECK(320 * 1024 / 2 > kLargestBlock);  // its half-size retry
  CHECK(kRing + 3 * kChunk * 2 < kLargestBlock / 2);
}

TEST_CASE("a real-time paced reply 8x the ring plays to the end, nothing dropped") {
  bob::PcmRing ring(kRing, kPrebuffer);
  REQUIRE(ring.ok());
  const Played p = play(ring, kReplyBytes, [](int) { return 1; });
  CHECK(p.samples == kReplyBytes / 2);
  CHECK(p.inOrder);
  CHECK(ring.droppedBytes() == 0);
  CHECK(ring.underruns() == 0);
  CHECK(ring.peak() <= kRing);
}

TEST_CASE("today's half-rate PCM pacing still plays every sample, with rebuffers") {
  bob::PcmRing ring(kRing, kPrebuffer);
  REQUIRE(ring.ok());
  // streamFrames(..., null): one 320 B frame, then delay(20 ms).
  const Played p = play(ring, kReplyBytes, [](int tick) { return tick % 2 == 0 ? 1 : 0; });
  CHECK(p.samples == kReplyBytes / 2);
  CHECK(p.inOrder);
  CHECK(ring.droppedBytes() == 0);
  CHECK(ring.underruns() > 0);
}

TEST_CASE("a reply shorter than the prebuffer plays once the stream ends") {
  bob::PcmRing ring(kRing, kPrebuffer);
  const Played p = play(ring, 40 * kFrameBytes, [](int) { return 1; });
  CHECK(p.samples == 40 * kFrameBytes / 2);
  CHECK(ring.underruns() == 0);
}

TEST_CASE("an unpaced burst overflows: counted, never a crash") {
  bob::PcmRing ring(kRing, kPrebuffer);
  std::vector<uint8_t> frame(kFrameBytes, 0x11);
  size_t stored = 0;
  for (size_t sent = 0; sent < kReplyBytes; sent += kFrameBytes) {
    stored += ring.push(frame.data(), frame.size());
  }
  CHECK(stored == kRing);
  CHECK(ring.droppedBytes() == kReplyBytes - kRing);
  CHECK(ring.push(frame.data(), 3) == 0);  // odd tail byte counts as dropped too
  std::vector<int16_t> chunk(kChunk);
  size_t drained = 0;
  while (size_t n = ring.take(chunk.data(), kChunk, true, true)) drained += n;
  CHECK(drained * 2 == kRing);
}

TEST_CASE("a failed allocation reports it instead of playing silence") {
  bob::PcmRing ring(0, kPrebuffer);
  CHECK_FALSE(ring.ok());
  const uint8_t b[2] = {1, 2};
  CHECK(ring.push(b, 2) == 0);
  int16_t s = 0;
  CHECK(ring.take(&s, 1, true, true) == 0);
}
