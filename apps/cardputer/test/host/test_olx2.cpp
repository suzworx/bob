// OLX2 downlink header decode (parseOlx2Header) against the headers the
// server's serializeAudioFrame writes (test/fixtures/wire/frames), plus every
// rejection branch.
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#include "doctest.h"
#include "protocol.h"
// After protocol.h: config.h uses uint32_t/size_t without including <cstdint>,
// relying on Arduino.h coming first, as it does in the firmware.
#include "config.h"
#include "uplink_queue.h"

namespace {

struct FrameFixture {
  std::string name;
  std::vector<uint8_t> frame;  // header + payloadBytes zero bytes.
  unsigned long formatId, turnHandle, sequence, payloadBytes;
};

// Reads `"key": <digits>` or `"key": "<text>"` after `from` in the fixture.
std::string field(const std::string& text, size_t from, const std::string& key) {
  size_t pos = text.find("\"" + key + "\": ", from);
  REQUIRE(pos != std::string::npos);
  pos += key.size() + 4;
  if (text[pos] == '"') return text.substr(pos + 1, text.find('"', pos + 1) - pos - 1);
  return text.substr(pos, text.find_first_not_of("0123456789", pos) - pos);
}

std::string readFixture(const char* path) {
  std::ifstream file(path, std::ios::binary);
  REQUIRE(file);
  std::stringstream buffer;
  buffer << file.rdbuf();
  return buffer.str();
}

std::vector<uint8_t> fromHex(const std::string& hex) {
  std::vector<uint8_t> bytes;
  for (size_t i = 0; i + 1 < hex.size(); i += 2) {
    bytes.push_back(static_cast<uint8_t>(std::strtoul(hex.substr(i, 2).c_str(), nullptr, 16)));
  }
  return bytes;
}

std::vector<FrameFixture> loadFrames() {
  const std::string text = readFixture("test/fixtures/wire/frames/olx2_audio_down.json");
  std::vector<FrameFixture> frames;
  for (size_t at = text.find("\"name\": "); at != std::string::npos; at = text.find("\"name\": ", at + 1)) {
    FrameFixture f;
    f.name = field(text, at, "name");
    f.formatId = std::stoul(field(text, at, "formatId"));
    f.turnHandle = std::stoul(field(text, at, "turnHandle"));
    f.sequence = std::stoul(field(text, at, "sequence"));
    f.payloadBytes = std::stoul(field(text, at, "payloadBytes"));
    f.frame = fromHex(field(text, at, "headerHex"));
    f.frame.resize(f.frame.size() + f.payloadBytes, 0);
    frames.push_back(f);
  }
  return frames;
}

}  // namespace

TEST_CASE("OLX2: the server's PCM and MP3 downlink headers decode field for field") {
  const auto frames = loadFrames();
  REQUIRE(frames.size() == 2);
  for (const auto& f : frames) {
    CAPTURE(f.name);
    REQUIRE(f.frame.size() == bob::config::kHeaderBytes + f.payloadBytes);
    bob::Olx2Header header{};
    REQUIRE(bob::parseOlx2Header(f.frame.data(), f.frame.size(), &header));
    CHECK(header.version == bob::config::kFrameVersion);
    CHECK(header.kind == bob::config::kKindAudioDown);
    CHECK(header.formatId == f.formatId);
    CHECK(header.channels == 1);
    CHECK(header.turnHandle == f.turnHandle);
    CHECK(header.sequence == f.sequence);
    CHECK(header.payloadBytes == f.payloadBytes);
  }
}

TEST_CASE("OLX2: every malformed header is rejected") {
  const auto frames = loadFrames();
  const std::vector<uint8_t> pcm = frames.at(0).frame;
  const std::vector<uint8_t> mp3 = frames.at(1).frame;
  bob::Olx2Header header{};
  auto rejects = [&](std::vector<uint8_t> frame) {
    return !bob::parseOlx2Header(frame.data(), frame.size(), &header);
  };
  auto mutate = [](std::vector<uint8_t> frame, size_t at, uint8_t value) {
    frame[at] = value;
    return frame;
  };

  CHECK_FALSE(bob::parseOlx2Header(pcm.data(), pcm.size(), nullptr));
  CHECK(rejects(std::vector<uint8_t>(pcm.begin(), pcm.begin() + 19)));        // short header
  CHECK(rejects(std::vector<uint8_t>(pcm.begin(), pcm.end() - 1)));           // payload shorter than declared
  CHECK(rejects(mutate(pcm, 3, '3')));                                        // magic OLX3
  CHECK(rejects(mutate(pcm, 4, 2)));                                          // version 2
  CHECK(rejects(mutate(pcm, 6, 3)));                                          // unknown format
  CHECK(rejects(mutate(pcm, 7, 2)));                                          // stereo
  CHECK(rejects(mutate(mutate(mp3, 6, 1), 18, 0x04)));                        // 1024 B declared PCM (> 320)

  std::vector<uint8_t> pcm321 = pcm;
  pcm321.push_back(0);
  pcm321[19] = 0x41;  // 321 bytes
  CHECK(rejects(pcm321));
  std::vector<uint8_t> mp31025 = mp3;
  mp31025.push_back(0);
  mp31025[19] = 0x01;  // 0x401 = 1025 bytes
  CHECK(rejects(mp31025));
}

// The batched uplink seam (frames/olx2_audio_up_batch.json, also replayed by the
// server's wire-fixtures.test.ts): captured 10 ms frames, framed as
// AudioCapture::sendFrame frames them (its own per-frame sequence), packed into
// per-message audio_up batches that must equal the fixture byte for byte.
TEST_CASE("OLX2: packUplinkBatch reproduces the shared batched audio_up fixture byte for byte") {
  const std::string text = readFixture("test/fixtures/wire/frames/olx2_audio_up_batch.json");
  constexpr size_t kPcm = bob::kUplinkFramePcmBytes;
  uint32_t captured = 0;  // the turn's frame index k, AudioCapture's sequence_.
  uint32_t messages = 0;
  for (size_t at = text.find("\"sequence\": "); at != std::string::npos; at = text.find("\"sequence\": ", at + 1)) {
    const auto n = static_cast<size_t>(std::stoul(field(text, at, "frames")));
    const std::vector<uint8_t> expected = fromHex(field(text, at, "hex"));
    CAPTURE(messages);
    REQUIRE(std::stoul(field(text, at, "sequence")) == messages);
    std::vector<std::vector<uint8_t>> frames(n, std::vector<uint8_t>(bob::config::kPcmFrameBytes, 0));
    for (auto& frame : frames) {
      std::memcpy(frame.data(), bob::config::kFrameMagic, 4);
      frame[4] = bob::config::kFrameVersion;
      frame[5] = bob::config::kKindAudioUp;
      frame[6] = bob::config::kFormatPcm16;
      frame[7] = 1;
      bob::writeU32(frame.data(), 8, 1);
      bob::writeU32(frame.data(), 12, captured);
      bob::writeU32(frame.data(), 16, kPcm);
      for (size_t j = 0; j < kPcm; ++j) frame[bob::config::kHeaderBytes + j] = static_cast<uint8_t>((captured * 37 + j * 3) & 0xFF);
      ++captured;
    }
    uint8_t out[bob::kUplinkBatchBytes] = {};
    const size_t bytes = bob::packUplinkBatch([&](size_t i) { return frames[i].data(); }, n, messages, out);
    REQUIRE(bytes == expected.size());
    CHECK(std::vector<uint8_t>(out, out + bytes) == expected);
    ++messages;
  }
  REQUIRE(messages == 3);
  CHECK(captured == 14);
  // turn_end names the last message's sequence (messages - 1), not the frame count.
  const String turnEnd = bob::buildTurnEnd("turn_0001_abcd", messages);
  const std::string seq = "\"seq\":" + field(text, 0, "turnEndSeq") + ",";
  CHECK(std::string(turnEnd.c_str()).find(seq) != std::string::npos);
}
