// The outbound control queue (include/control_queue.h): FIFO order, the
// device_state slot, bounds, and the type read for control_dropped. Driven
// with the real firmware builder bytes from test/fixtures/wire.
#include <string>

#include "control_queue.h"
#include "doctest.h"
#include "support.h"

using hosttest::fixture;

namespace {

// Three messages deep, with bytes to spare: these cases hit the count bound.
using Queue = bob::ControlQueue<3, 1536, 512>;

bob::ControlPush push(Queue& queue, const String& body) {
  return queue.push(body.c_str(), body.length());
}

bob::ControlPush push(Queue& queue, const std::string& body) {
  return queue.push(body.c_str(), body.size());
}

// The next message's type, or "" when the queue is empty.
std::string next(Queue& queue) {
  char out[512];
  size_t length = 0;
  if (!queue.pop(out, sizeof(out), &length)) return "";
  CHECK(length == std::string(out).size());
  char type[bob::kControlTypeBytes];
  bob::controlType(out, type, sizeof(type));
  return type;
}

}  // namespace

TEST_CASE("control messages leave in the order they were queued") {
  Queue queue;
  CHECK(push(queue, fixture("turn_start")) == bob::ControlPush::kQueued);
  CHECK(push(queue, fixture("turn_end")) == bob::ControlPush::kQueued);
  CHECK(push(queue, fixture("cancel")) == bob::ControlPush::kQueued);
  CHECK(queue.size() == 3);
  CHECK(next(queue) == "turn_start");
  CHECK(next(queue) == "turn_end");
  CHECK(next(queue) == "cancel");
  CHECK(next(queue).empty());
  CHECK(queue.empty());
}

TEST_CASE("the exact bytes come back out, NUL-terminated") {
  Queue queue;
  const String body = fixture("announce_ack");
  REQUIRE(push(queue, body) == bob::ControlPush::kQueued);
  char out[512];
  size_t length = 0;
  REQUIRE(queue.pop(out, sizeof(out), &length));
  CHECK(std::string(out) == std::string(body.c_str()));
  CHECK(length == body.length());
}

TEST_CASE("a cancel is never queued behind a device_state") {
  Queue queue;
  CHECK(push(queue, fixture("device_state")) == bob::ControlPush::kQueued);
  CHECK(push(queue, fixture("cancel")) == bob::ControlPush::kQueued);
  CHECK(next(queue) == "cancel");
  CHECK(next(queue) == "device_state");
}

TEST_CASE("a newer device_state replaces the unsent one and never takes a FIFO slot") {
  Queue queue;
  CHECK(push(queue, fixture("device_state")) == bob::ControlPush::kQueued);
  CHECK(push(queue, fixture("device_state_unknown_battery")) == bob::ControlPush::kReplaced);
  CHECK(queue.size() == 1);
  for (int i = 0; i < 3; ++i) CHECK(push(queue, fixture("cancel")) == bob::ControlPush::kQueued);
  CHECK(queue.size() == 4);
  char out[512];
  size_t length = 0;
  for (int i = 0; i < 3; ++i) REQUIRE(queue.pop(out, sizeof(out), &length));
  REQUIRE(queue.pop(out, sizeof(out), &length));
  CHECK(std::string(out) == std::string(fixture("device_state_unknown_battery").c_str()));
}

TEST_CASE("a full FIFO refuses the next message and keeps the queued ones") {
  Queue queue;
  for (int i = 0; i < 3; ++i) CHECK(push(queue, fixture("turn_start")) == bob::ControlPush::kQueued);
  CHECK(push(queue, fixture("cancel")) == bob::ControlPush::kFull);
  CHECK(push(queue, fixture("device_state")) == bob::ControlPush::kQueued);  // its own slot.
  CHECK(next(queue) == "turn_start");
  CHECK(push(queue, fixture("cancel")) == bob::ControlPush::kQueued);  // room again.
  CHECK(next(queue) == "turn_start");
  CHECK(next(queue) == "turn_start");
  CHECK(next(queue) == "cancel");
  CHECK(next(queue) == "device_state");
}

TEST_CASE("the ring wraps around many times without losing order") {
  Queue queue;
  const char* types[] = {"turn_start", "turn_end", "cancel"};
  for (int round = 0; round < 50; ++round) {
    for (const char* type : types) {
      REQUIRE(push(queue, std::string("{\"v\":1,\"type\":\"") + type + "\",\"payload\":{}}") ==
              bob::ControlPush::kQueued);
      CHECK(next(queue) == type);
    }
  }
  CHECK(queue.empty());
}

TEST_CASE("the byte bound refuses a message before the count bound is reached") {
  bob::ControlQueue<8, 600, 512> queue;
  const std::string big(511, 'b');
  REQUIRE(queue.push(big.c_str(), big.size()) == bob::ControlPush::kQueued);  // 513 of 600 bytes.
  const std::string small(100, 's');
  CHECK(queue.push(small.c_str(), small.size()) == bob::ControlPush::kFull);
  const std::string tiny(80, 't');
  CHECK(queue.push(tiny.c_str(), tiny.size()) == bob::ControlPush::kQueued);  // 595 of 600.
  char out[512];
  size_t length = 0;
  REQUIRE(queue.pop(out, sizeof(out), &length));
  CHECK(std::string(out) == big);
  CHECK(queue.push(small.c_str(), small.size()) == bob::ControlPush::kQueued);
  REQUIRE(queue.pop(out, sizeof(out), &length));
  CHECK(std::string(out) == tiny);
  REQUIRE(queue.pop(out, sizeof(out), &length));
  CHECK(std::string(out) == small);
  CHECK(queue.empty());
}

TEST_CASE("messages of every size survive the ring's wrap byte for byte") {
  // 701 bytes: prime, so prefixes and bodies land across the wrap point.
  bob::ControlQueue<8, 701, 512> queue;
  std::string sent[4];
  size_t pending = 0;
  for (int i = 0; i < 400; ++i) {
    const size_t length = 1 + static_cast<size_t>(i * 37) % 250;
    std::string body(length, static_cast<char>('a' + i % 26));
    body[0] = static_cast<char>('0' + i % 10);
    if (queue.push(body.c_str(), body.size()) != bob::ControlPush::kQueued) {
      // Full: drain one and retry, checking FIFO order on the way.
      char out[512];
      size_t n = 0;
      REQUIRE(queue.pop(out, sizeof(out), &n));
      CHECK(std::string(out, n) == sent[(i - static_cast<int>(pending)) % 4]);
      --pending;
      REQUIRE(queue.push(body.c_str(), body.size()) == bob::ControlPush::kQueued);
    }
    sent[i % 4] = body;
    ++pending;
    if (pending == 4) {
      char out[512];
      size_t n = 0;
      REQUIRE(queue.pop(out, sizeof(out), &n));
      CHECK(std::string(out, n) == sent[(i - 3) % 4]);
      --pending;
    }
  }
}

TEST_CASE("empty and oversize messages are refused") {
  Queue queue;
  CHECK(queue.push("", 0) == bob::ControlPush::kTooLong);
  const std::string exact(511, 'a');
  const std::string over(512, 'a');
  CHECK(push(queue, exact) == bob::ControlPush::kQueued);
  CHECK(push(queue, over) == bob::ControlPush::kTooLong);
  CHECK(queue.size() == 1);
}

TEST_CASE("pop refuses an output buffer that cannot hold the message") {
  Queue queue;
  REQUIRE(push(queue, fixture("cancel")) == bob::ControlPush::kQueued);
  char small[8];
  CHECK_FALSE(queue.pop(small, sizeof(small), nullptr));
  CHECK(queue.size() == 1);  // still queued.
}

TEST_CASE("controlType reads the wire type and nothing else") {
  char type[bob::kControlTypeBytes];
  bob::controlType(fixture("announce_ack").c_str(), type, sizeof(type));
  CHECK(std::string(type) == "announce_ack");
  bob::controlType("{\"payload\":{}}", type, sizeof(type));
  CHECK(std::string(type) == "unknown");
  bob::controlType(nullptr, type, sizeof(type));
  CHECK(std::string(type) == "unknown");
  bob::controlType("{\"type\":\"a_type_name_longer_than_the_buffer\"}", type, sizeof(type));
  CHECK(std::string(type).size() == sizeof(type) - 1);
}
