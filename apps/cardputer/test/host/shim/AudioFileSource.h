// Host shim: the ESP8266Audio AudioFileSource virtuals that
// src/mp3_ring_source.h overrides, with the same signatures.
#pragma once

#include <cstdint>

class AudioFileSource {
 public:
  AudioFileSource() = default;
  virtual ~AudioFileSource() = default;
  virtual bool open(const char* filename) = 0;
  virtual uint32_t read(void* data, uint32_t len) = 0;
  virtual uint32_t readNonBlock(void* data, uint32_t len) { return read(data, len); }
  virtual bool seek(int32_t pos, int dir) = 0;
  virtual bool close() = 0;
  virtual bool isOpen() = 0;
  virtual uint32_t getSize() = 0;
  virtual uint32_t getPos() = 0;
};
