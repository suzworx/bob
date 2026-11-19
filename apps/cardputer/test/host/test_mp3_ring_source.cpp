// The MP3 ring source (src/mp3_ring_source.h) against the order that dropped
// whole replies (HIL run 20260929-064635-40fc, wake-followup step 22):
//   playback_started -> playback_end_received -> playback_ending frames=17
//   -> mp3_ring_ready avail=16416,eof=1 -> mp3_began ok=0 -> mp3_begin_failed
// ESP8266Audio's AudioGeneratorMP3::begin() refuses a source whose isOpen()
// is false; finishStream() closed the source, so a reply that was fully
// buffered before the decode task reached begin() never played.
#include <cstring>
#include <vector>

#include "doctest.h"
#include "../../src/mp3_ring_source.h"

namespace {

constexpr size_t kRing = 48 * 1024;  // config::kMp3RingBufferBytes

// The decoder's view: begin() gates on isOpen(); loop() then reads until a
// read returns 0, which the ring only does once the stream has ended.
bool beginAccepts(AudioFileSource& source) { return source.isOpen(); }

size_t drainAll(AudioFileSource& source) {
  uint8_t chunk[1600];
  size_t total = 0;
  while (true) {
    const uint32_t got = source.read(chunk, sizeof(chunk));
    if (got == 0) return total;
    total += got;
  }
}

// The network side: 17 audio_down frames of an BOB_STREAMING_REPLY=0 reply.
void pushReply(bob::ByteRingBuffer& ring, size_t bytes) {
  std::vector<uint8_t> frame(1026, 0xA5);
  while (bytes > 0) {
    const size_t len = bytes < frame.size() ? bytes : frame.size();
    REQUIRE(ring.push(frame.data(), len) == len);
    bytes -= len;
  }
}

bob::RingBufferFileSource* g_source = nullptr;
bob::ByteRingBuffer* g_ring = nullptr;
int g_pollsLeft = 0;
size_t g_lateBytes = 0;

// While the decoder waits on an empty ring: after a few polls the rest of the
// reply arrives, then playback_end.
void lateProducer() {
  if (--g_pollsLeft > 0) return;
  if (g_lateBytes > 0) {
    pushReply(*g_ring, g_lateBytes);
    g_lateBytes = 0;
    g_pollsLeft = 3;
    return;
  }
  bob::endMp3Stream(g_source);
}

}  // namespace

TEST_CASE("the whole reply and playback_end land before begin(): it still plays") {
  bob::ByteRingBuffer ring(kRing);
  bob::RingBufferFileSource source(&ring);
  source.open("");
  pushReply(ring, 16416);
  bob::endMp3Stream(&source);  // playback_end, before the decode task runs
  CHECK(ring.available() == 16416);
  CHECK(ring.isEof());
  CHECK(beginAccepts(source));
  CHECK(drainAll(source) == 16416);
}

TEST_CASE("the whole reply without playback_end: begin() then waits for the end") {
  bob::ByteRingBuffer ring(kRing);
  bob::RingBufferFileSource source(&ring);
  source.open("");
  pushReply(ring, 16416);
  CHECK(beginAccepts(source));
  g_source = &source;
  g_ring = &ring;
  g_pollsLeft = 3;
  g_lateBytes = 0;
  hostshim::g_onTaskDelay = lateProducer;
  CHECK(drainAll(source) == 16416);
  hostshim::g_onTaskDelay = nullptr;
  CHECK(ring.emptyPolls() >= 3);
}

TEST_CASE("a partial buffer (4096 of 6144, eof=0) waits for the rest") {
  bob::ByteRingBuffer ring(kRing);
  bob::RingBufferFileSource source(&ring);
  source.open("");
  pushReply(ring, 4096);
  CHECK(beginAccepts(source));
  g_source = &source;
  g_ring = &ring;
  g_pollsLeft = 3;
  g_lateBytes = 2048;
  hostshim::g_onTaskDelay = lateProducer;
  CHECK(drainAll(source) == 6144);
  hostshim::g_onTaskDelay = nullptr;
}

TEST_CASE("an abort before begin() closes the source: begin() fails, reads end") {
  bob::ByteRingBuffer ring(kRing);
  bob::RingBufferFileSource source(&ring);
  source.open("");
  pushReply(ring, 4096);
  source.close();  // AudioPlayback::abort()
  CHECK_FALSE(beginAccepts(source));
  CHECK(ring.isEof());
  CHECK(ring.push(reinterpret_cast<const uint8_t*>("x"), 1) == 0);
}
