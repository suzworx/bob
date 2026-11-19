// Bob Cardputer v2 — the MP3 downlink ring and the AudioFileSource that
// feeds it to the decoder. Header-only so the host tests
// (test/host/test_mp3_ring_source.cpp) drive these exact classes.
#pragma once

#include <Arduino.h>
#include <AudioFileSource.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace bob {

// Simple thread-safe byte ring buffer for the MP3 streaming path.
class ByteRingBuffer {
 public:
  explicit ByteRingBuffer(size_t capacity)
      : buffer_(nullptr),
        capacity_(capacity),
        head_(0),
        tail_(0),
        count_(0),
        eof_(false),
        waitMicros_(0),
        emptyPolls_(0),
        watermark_(0),
        mutex_(nullptr) {
    if (capacity_ > 0) {
      buffer_ = static_cast<uint8_t*>(malloc(capacity_));
      if (!buffer_) {
        capacity_ = 0;
      }
    }
    mutex_ = xSemaphoreCreateMutex();
  }

  ~ByteRingBuffer() {
    if (buffer_) {
      free(buffer_);
      buffer_ = nullptr;
    }
    if (mutex_) {
      vSemaphoreDelete(mutex_);
      mutex_ = nullptr;
    }
  }

  ByteRingBuffer(const ByteRingBuffer&) = delete;
  ByteRingBuffer& operator=(const ByteRingBuffer&) = delete;

  size_t push(const uint8_t* data, size_t len) {
    if (!buffer_ || !mutex_ || len == 0) return 0;
    xSemaphoreTake(mutex_, portMAX_DELAY);
    if (eof_) {
      xSemaphoreGive(mutex_);
      return 0;
    }
    size_t pushed = 0;
    for (size_t i = 0; i < len && count_ < capacity_; ++i) {
      buffer_[head_] = data[i];
      head_ = (head_ + 1) % capacity_;
      count_++;
      pushed++;
    }
    if (count_ > watermark_) watermark_ = count_;
    xSemaphoreGive(mutex_);
    return pushed;
  }

  size_t read(uint8_t* data, size_t len) {
    if (!buffer_ || !mutex_) return 0;
    // Diagnostics: total time the decode task waited on an empty ring and how
    // many 20 ms polls it took, distinguishing decode starvation (wait high)
    // from decode CPU load (wait low, decode_cpu high).
    const uint32_t waitStart = micros();
    while (true) {
      xSemaphoreTake(mutex_, portMAX_DELAY);
      if (count_ > 0) {
        size_t readBytes = 0;
        for (size_t i = 0; i < len && count_ > 0; ++i) {
          data[i] = buffer_[tail_];
          tail_ = (tail_ + 1) % capacity_;
          count_--;
          readBytes++;
        }
        xSemaphoreGive(mutex_);
        waitMicros_ += micros() - waitStart;
        return readBytes;
      }
      emptyPolls_++;
      bool closed = eof_;
      xSemaphoreGive(mutex_);
      if (closed) {
        waitMicros_ += micros() - waitStart;
        return 0;
      }
      vTaskDelay(2);  // 20 ms at 100 Hz tick; pdMS_TO_TICKS(1) truncates to 0
    }
  }

  void close() {
    if (!mutex_) return;
    xSemaphoreTake(mutex_, portMAX_DELAY);
    eof_ = true;
    xSemaphoreGive(mutex_);
  }

  size_t available() const {
    if (!mutex_) return 0;
    xSemaphoreTake(mutex_, portMAX_DELAY);
    size_t avail = count_;
    xSemaphoreGive(mutex_);
    return avail;
  }

  bool isEof() const {
    if (!mutex_) return false;
    xSemaphoreTake(mutex_, portMAX_DELAY);
    bool eof = eof_;
    xSemaphoreGive(mutex_);
    return eof;
  }

  // Diagnostics accessors: cumulative empty-wait time, empty-poll count, and
  // the highest fill level ever reached (M8 ring high-water mark).
  size_t waitMicros() const { return waitMicros_; }
  uint32_t emptyPolls() const { return emptyPolls_; }
  size_t watermark() const { return watermark_; }

 private:
  uint8_t* buffer_;
  size_t capacity_;
  size_t head_;
  size_t tail_;
  size_t count_;
  bool eof_;
  uint32_t waitMicros_;
  uint32_t emptyPolls_;
  size_t watermark_;
  SemaphoreHandle_t mutex_;
};

// AudioFileSource adapter that feeds the MP3 decoder from the ring buffer.
// Two different ends: endOfData() is playback_end (the server sent the last
// byte; the source stays open so begin() still accepts it and the decoder
// drains the ring), close() is abort/stop (the source is closed, so a begin()
// that has not run yet fails and ends the reply). ESP8266Audio's begin()
// returns false on a source whose isOpen() is false; finishStream() used to
// call close(), so a reply fully buffered before the decode task reached
// begin() was dropped (mp3_begin_failed right after playback_ending, HIL run
// 20260929-064635-40fc).
class RingBufferFileSource : public AudioFileSource {
 public:
  explicit RingBufferFileSource(ByteRingBuffer* ring)
      : ring_(ring), open_(false) {}

  bool open(const char* filename) override {
    (void)filename;
    open_ = true;
    return true;
  }

  // The last byte is in: blocked and later reads return what is buffered,
  // then 0 (EOF). The source stays open.
  void endOfData() {
    if (ring_) ring_->close();
  }

  bool close() override {
    if (ring_) ring_->close();
    open_ = false;
    return true;
  }

  bool isOpen() override { return open_; }

  uint32_t read(void* data, uint32_t len) override {
    if (!ring_ || len == 0 || !data) return 0;
    size_t readBytes = ring_->read(static_cast<uint8_t*>(data), static_cast<size_t>(len));
    return static_cast<uint32_t>(readBytes);
  }

  uint32_t readNonBlock(void* data, uint32_t len) override {
    return read(data, len);
  }

  bool seek(int32_t pos, int dir) override {
    (void)pos;
    (void)dir;
    return false;
  }

  uint32_t getSize() override { return 0; }
  uint32_t getPos() override { return 0; }

 private:
  ByteRingBuffer* ring_;
  bool open_;
};

// What AudioPlayback::finishStream() does to the source on playback_end.
inline void endMp3Stream(RingBufferFileSource* source) {
  if (source) source->endOfData();
}

// The PCM16 downlink ring (#674). The PCM path used to buffer the whole reply
// in one 320 KB internal block (160 KB retry); the largest free block is
// ~156 KB, so every PCM reply failed with playback_buffer_failed. This ring is
// bounded and streams: pushDownlink() stores whole samples (a full ring drops
// and counts, never blocks), and take() hands the speaker chunks behind a
// jitter gate that opens at `prebufferBytes` or when the stream has ended, and
// closes again only on a real underrun (ring AND speaker empty mid-stream).
// Single-task: pushDownlink() and loop() both run on the Arduino loop task.
class PcmRing {
 public:
  PcmRing(size_t capacityBytes, size_t prebufferBytes)
      : buffer_(nullptr),
        capacity_(capacityBytes & ~static_cast<size_t>(1)),
        prebuffer_(prebufferBytes),
        head_(0),
        tail_(0),
        count_(0),
        peak_(0),
        dropped_(0),
        underruns_(0),
        gateOpen_(false) {
    if (capacity_ > 0) buffer_ = static_cast<uint8_t*>(malloc(capacity_));
    if (!buffer_) capacity_ = 0;
    if (prebuffer_ > capacity_) prebuffer_ = capacity_;
  }

  ~PcmRing() { free(buffer_); }

  PcmRing(const PcmRing&) = delete;
  PcmRing& operator=(const PcmRing&) = delete;

  bool ok() const { return buffer_ != nullptr; }

  // Stores whole samples; returns the bytes stored. The rest are counted in
  // droppedBytes().
  size_t push(const uint8_t* data, size_t len) {
    size_t n = (len & ~static_cast<size_t>(1));
    if (!buffer_ || !data) n = 0;
    if (n > capacity_ - count_) n = capacity_ - count_;
    const size_t first = n < capacity_ - head_ ? n : capacity_ - head_;
    if (n > 0) {
      memcpy(buffer_ + head_, data, first);
      memcpy(buffer_, data + first, n - first);
    }
    head_ = (head_ + n) % (capacity_ ? capacity_ : 1);
    count_ += n;
    if (count_ > peak_) peak_ = count_;
    dropped_ += static_cast<uint32_t>(len - n);
    return n;
  }

  // Up to `maxSamples` for the speaker, 0 = hold. Mid-stream it only hands out
  // full chunks unless the speaker is starving, so each queue slot carries a
  // chunk's worth of audio rather than one 10 ms frame.
  size_t take(int16_t* out, size_t maxSamples, bool ended, bool speakerIdle) {
    if (!buffer_ || !out || maxSamples == 0) return 0;
    if (!gateOpen_) {
      if (count_ < prebuffer_ && !(ended && count_ > 0)) return 0;
      gateOpen_ = true;
    }
    const size_t want = maxSamples * sizeof(int16_t);
    if (count_ == 0 || (!ended && !speakerIdle && count_ < want)) {
      if (count_ == 0 && speakerIdle && !ended) {
        gateOpen_ = false;
        underruns_++;
      }
      return 0;
    }
    const size_t n = (count_ < want ? count_ : want);
    const size_t first = n < capacity_ - tail_ ? n : capacity_ - tail_;
    uint8_t* dst = reinterpret_cast<uint8_t*>(out);
    memcpy(dst, buffer_ + tail_, first);
    memcpy(dst + first, buffer_, n - first);
    tail_ = (tail_ + n) % capacity_;
    count_ -= n;
    return n / sizeof(int16_t);
  }

  size_t available() const { return count_; }
  size_t capacity() const { return capacity_; }
  size_t peak() const { return peak_; }
  uint32_t droppedBytes() const { return dropped_; }
  uint32_t underruns() const { return underruns_; }

 private:
  uint8_t* buffer_;
  size_t capacity_;
  size_t prebuffer_;
  size_t head_;
  size_t tail_;
  size_t count_;
  size_t peak_;
  uint32_t dropped_;
  uint32_t underruns_;
  bool gateOpen_;
};

}  // namespace bob
