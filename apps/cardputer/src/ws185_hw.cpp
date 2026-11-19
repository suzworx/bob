#if defined(BOB_BOARD_WAVESHARE_185C)

#include "ws185_hw.h"
#include "ws185_panel.h"
#if defined(BOB_TEST_CONSOLE)
#include "ws185_panel_tune.h"
#include <stdio.h>
#include <string.h>
#endif

#include <Arduino.h>
#include <M5Unified.h>
#include <driver/i2s.h>
#include <freertos/semphr.h>

#include "speaker_test.h"

namespace bob
{
namespace ws185
{
namespace
{
constexpr int kSda = 11, kScl = 10;
constexpr uint32_t kI2cHz = 400000;
constexpr uint8_t kTca = 0x20, kCst816 = 0x15, kEs7210 = 0x40, kEs8311 = 0x18;
constexpr int kI2sMclk = 2, kI2sBclk = 48, kI2sWs = 38, kI2sDout = 47, kI2sDin = 39;
constexpr int kBacklight = 5, kAmp = 15, kBoot = 0;
constexpr int kLcdCs = 21, kLcdSclk = 40, kLcdD0 = 46, kLcdD1 = 45, kLcdD2 = 42, kLcdD3 = 41;

// Static: M5.Display keeps pointers to the panel, bus and light for the life of the program.
lgfx::Bus_SPI s_bus;
lgfx::Panel_ST77916 s_panel;
lgfx::Light_PWM s_light;

// One lock for the whole I2C_NUM_0 bus: the loop task and the touch task both talk on it. Created in
// beginBus(); before that, a transaction runs unlocked (boot order).
SemaphoreHandle_t s_i2cMutex = nullptr;

// Holds the bus for one transaction. ok() is false only when the lock could not be taken in time.
struct I2cLock
{
  bool taken = false;
  bool ok_ = true;

  I2cLock()
  {
    if (!s_i2cMutex) { return; }
    taken = xSemaphoreTake(s_i2cMutex, pdMS_TO_TICKS(50)) == pdTRUE;
    ok_ = taken;
  }
  ~I2cLock()
  {
    if (taken) { xSemaphoreGive(s_i2cMutex); }
  }
  bool ok() const { return ok_; }
};

bool wr(uint8_t addr, uint8_t reg, uint8_t val)
{
  I2cLock lock;
  return lock.ok() && m5::In_I2C.writeRegister8(addr, reg, val, kI2cHz);
}

uint8_t rd(uint8_t addr, uint8_t reg)
{
  I2cLock lock;
  return lock.ok() ? m5::In_I2C.readRegister8(addr, reg, kI2cHz) : 0;
}

struct Reg
{
  uint8_t reg;
  uint8_t val;
};

bool writeAll(uint8_t addr, const Reg* regs, size_t n)
{
  bool ok = true;
  for (size_t i = 0; i < n; i++) { ok &= wr(addr, regs[i].reg, regs[i].val); }
  return ok;
}

// TCA9554 pins: EXIO1 touch reset (bit0), EXIO2 LCD reset (bit1), EXIO3 SD D3 (bit2).
bool tcaPulse(uint8_t bit)
{
  static uint8_t out = 0x07;
  bool ok = wr(kTca, 0x01, out);
  ok &= wr(kTca, 0x03, 0x00); // all outputs
  out = uint8_t(out & ~bit);
  ok &= wr(kTca, 0x01, out);
  delay(10);
  out = uint8_t(out | bit);
  ok &= wr(kTca, 0x01, out);
  delay(50);
  return ok;
}

} // namespace

bool beginBus()
{
  if (!s_i2cMutex) { s_i2cMutex = xSemaphoreCreateMutex(); }
  {
    I2cLock lock;
    if (!lock.ok() || !m5::In_I2C.begin(I2C_NUM_0, kSda, kScl)) { return false; }
  }
  bool ok;
  {
    I2cLock lock;
    ok = lock.ok() && m5::In_I2C.scanID(kTca);
  }
  ok &= tcaPulse(0x01);
  ok &= tcaPulse(0x02);
  return ok;
}

bool attachDisplay(int16_t viewW, int16_t viewH)
{
  auto bc = s_bus.config();
  bc.spi_host = SPI2_HOST;
  bc.spi_mode = 0;
  bc.freq_write = 40000000; // 80 MHz gave speckled pixels on the V2 board
  bc.pin_sclk = kLcdSclk;
  bc.pin_io0 = kLcdD0;
  bc.pin_io1 = kLcdD1;
  bc.pin_io2 = kLcdD2;
  bc.pin_io3 = kLcdD3;
  bc.use_lock = true;
  s_bus.config(bc);
  s_panel.setBus(&s_bus);

  auto pc = s_panel.config();
  pc.pin_cs = kLcdCs;
  pc.pin_rst = -1; // reset is TCA9554 EXIO2, pulsed in beginBus()
  pc.memory_width = 360;
  pc.memory_height = 360;
  pc.panel_width = 360; // full glass first, so the whole memory is cleared below
  pc.panel_height = 360;
  pc.offset_x = 0;
  pc.offset_y = 0;
  pc.readable = false;
  pc.invert = true;     // this panel needs inversion ON (0x21, as in Waveshare's table)
  pc.rgb_order = true;  // MADCTL BGR bit clear: RGB order, per the owner's photo
  pc.dlen_16bit = false;
  pc.bus_shared = false;
  s_panel.config(pc);

  auto lc = s_light.config();
  lc.pin_bl = kBacklight;
  lc.freq = 20000;
  lc.pwm_channel = 7;
  lc.invert = false;
  s_light.config(lc);
  s_panel.setLight(&s_light);

  // Works: M5GFX::init(Panel_Device*) after M5.begin(); M5.Display stays the one display object.
  if (!M5.Display.init(&s_panel)) { return false; }
  M5.Display.fillScreen(TFT_BLACK); // wipes the factory UI from the whole 360x360 memory
  M5.Display.setBrightness(200);
  if (viewW == 360 && viewH == 360) { return true; }
  // Smaller viewport centred in the glass (untested on hardware; the native UI is 360x360).
  pc.panel_width = viewW;
  pc.panel_height = viewH;
  pc.offset_x = (360 - viewW) / 2;
  pc.offset_y = (360 - viewH) / 2;
  s_panel.config(pc);
  M5.Display.setRotation(0);
  return M5.Display.width() == viewW && M5.Display.height() == viewH;
}

// ES8311, I2S slave, MCLK from pin at 256 x fs, 16-bit standard I2S. At MCLK = 256 fs the
// divider block is the same for every fs (pre_div 1, LRCK divider 256), so these registers
// serve any sample rate the speaker is opened at.
constexpr Reg kEs8311Init[] = {
  {0x00, 0x1F}, {0x00, 0x00}, {0x00, 0x80}, // reset, release, power-on slave
  {0x01, 0x3F},                             // all clocks on, MCLK from the pin
  {0x02, 0x00}, {0x03, 0x10}, {0x04, 0x10}, {0x05, 0x00},
  {0x06, 0x03}, {0x07, 0x00}, {0x08, 0xFF}, // LRCK divider 256
  {0x09, 0x0C}, {0x0A, 0x0C},               // SDP in/out: I2S, 16-bit
  {0x0D, 0x01}, {0x0E, 0x02}, {0x12, 0x00}, {0x13, 0x10}, // analog power, DAC on, HP drive
  {0x1C, 0x6A}, {0x37, 0x08},               // ADC DC cancel, DAC EQ bypass
  {0x31, 0x00}, {0x32, 0xBF},               // DAC unmuted, 0 dB
};

// ES7210, I2S slave, standard I2S (not TDM), 16-bit, MIC1 + MIC2, MCLK = 256 x 16 kHz.
// ES7210 PGA gain code 0..14 (0 dB .. 37.5 dB, 3 dB steps). 30 dB (code 10) put the idle floor at
// about 46 dB re one LSB against about 16 dB on the Cardputer, which the shared VAD thresholds
// (end_of_speech.h) are tuned for; the Waveshare is brought down at the source instead.
#ifndef BOB_WS185_MIC_GAIN
#define BOB_WS185_MIC_GAIN 7
#endif
constexpr uint8_t kMicGain = BOB_WS185_MIC_GAIN;

constexpr Reg kEs7210Init[] = {
  {0x00, 0xFF}, {0x00, 0x41}, {0x01, 0x1F},
  {0x09, 0x30}, {0x0A, 0x30}, {0x23, 0x2A}, {0x22, 0x0A}, {0x20, 0x0A}, {0x21, 0x2A},
  {0x40, 0xC3}, {0x41, 0x70}, {0x42, 0x70}, // analog on, mic bias
  {0x07, 0x20}, {0x02, 0x81}, {0x04, 0x01}, {0x05, 0x00}, // OSR, main clock, LRCK divider 256
  {0x11, 0x60}, {0x12, 0x00},               // 16-bit I2S, TDM off
  {0x43, 0x10 | kMicGain}, {0x44, 0x10 | kMicGain}, // MIC1/MIC2 enabled, gain steps of 3 dB
  {0x01, 0x14}, {0x06, 0x00}, {0x40, 0x43}, // clocks for ADC1/2, power up
  {0x47, 0x08}, {0x48, 0x08}, {0x4B, 0x00}, {0x4C, 0xFF},
};

#if defined(BOB_TEST_CONSOLE)
namespace
{
// What the hil console wrote to the panel since boot (#1065), for `T panel dump`.
struct PanelLog
{
  const char* table = "ws";
  char gammaLabel[8] = "ws";
  uint8_t pos[ws185tune::kGammaBytes] = {};
  uint8_t neg[ws185tune::kGammaBytes] = {};
  bool inv = true;      // cfg.invert: INVON after init
  int madctl = -1;      // -1: as init() set it (rotation 0, RGB: 0x00)
  struct Raw { uint8_t cmd, n, p0; } raw[6] = {};
  uint32_t rawCount = 0; // total raw commands; raw[] keeps the last six
} s_log;

void logGamma(const char* label, const uint8_t* pos, const uint8_t* neg)
{
  snprintf(s_log.gammaLabel, sizeof(s_log.gammaLabel), "%s", label);
  memcpy(s_log.pos, pos, ws185tune::kGammaBytes);
  memcpy(s_log.neg, neg, ws185tune::kGammaBytes);
}

size_t appendHex(char* out, size_t n, size_t len, const uint8_t* b, size_t count)
{
  for (size_t i = 0; i < count && len + 4 < n; ++i) { len += snprintf(out + len, n - len, i ? " %02X" : "%02X", b[i]); }
  return len;
}
} // namespace
#endif

void panelCommand(uint8_t cmd, const uint8_t* params, uint8_t n)
{
  M5.Display.waitDisplay();
  s_panel.sendRaw(cmd, params, n);
#if defined(BOB_TEST_CONSOLE)
  auto& r = s_log.raw[s_log.rawCount % 6];
  r = {cmd, n, n ? params[0] : uint8_t(0)};
  ++s_log.rawCount;
#endif
}

// The ES8311 output path: the registers that must hold their init values for the DAC to drive the
// amplifier (analog power, DAC power, HP drive, unmute, 0 dB). A subset of kEs8311Init, same values.
constexpr Reg kEs8311OutputPath[] = {
  {0x0D, 0x01}, {0x12, 0x00}, {0x13, 0x10}, {0x31, 0x00}, {0x32, 0xBF},
};
constexpr size_t kOutputPathCount = sizeof(kEs8311OutputPath) / sizeof(Reg);
constexpr uint8_t kEs8311ChipId = 0x83;

bool g_ampOn = false;

#if defined(BOB_TEST_CONSOLE)
void panelGamma(const uint8_t pos[14], const uint8_t neg[14], const char* label)
{
  // Gamma page as the init tables enter it (F0 00, F0 02), then back to the normal page (F0 00).
  static constexpr uint8_t kPage0 = 0x00, kGammaPage = 0x02;
  M5.Display.waitDisplay();
  s_panel.sendRaw(0xF0, &kPage0, 1);
  s_panel.sendRaw(0xF0, &kGammaPage, 1);
  s_panel.sendRaw(0xE0, pos, 14);
  s_panel.sendRaw(0xE1, neg, 14);
  s_panel.sendRaw(0xF0, &kPage0, 1);
  logGamma(label, pos, neg);
}

void panelInvert(bool on)
{
  M5.Display.waitDisplay();
  s_panel.sendRaw(on ? 0x21 : 0x20, nullptr, 0);
  s_log.inv = on;
}

void panelMadctl(uint8_t value)
{
  M5.Display.waitDisplay();
  s_panel.sendRaw(0x36, &value, 1);
  s_log.madctl = value;
}

bool panelInit(const char* table)
{
  const bool esp = strcmp(table, "esp") == 0;
  if (!esp && strcmp(table, "ws") != 0) { return false; }
  M5.Display.waitDisplay();
  s_panel.reinit(esp);
  s_log.table = esp ? "esp" : "ws";
  const ws185tune::GammaPreset* g = ws185tune::findGammaPreset(s_log.table);
  logGamma(g->name, g->pos, g->neg);
  s_log.inv = true;
  s_log.madctl = -1;
  return true;
}

void panelReadId(uint8_t id[4])
{
  M5.Display.waitDisplay();
  s_bus.setReadClock(5000000); // the demo probes RDDID at 5 MHz; only reads use this clock
  s_panel.readDisplayId(id);
}

void panelGammaCurrent(uint8_t pos[14], uint8_t neg[14])
{
  if (s_log.pos[0] == 0 && s_log.neg[0] == 0) // nothing written yet: the product table's gamma
  {
    const ws185tune::GammaPreset* g = ws185tune::findGammaPreset("ws");
    logGamma(g->name, g->pos, g->neg);
  }
  memcpy(pos, s_log.pos, ws185tune::kGammaBytes);
  memcpy(neg, s_log.neg, ws185tune::kGammaBytes);
}

void panelDump(char* out, size_t n)
{
  uint8_t pos[ws185tune::kGammaBytes], neg[ws185tune::kGammaBytes];
  panelGammaCurrent(pos, neg);
  char mad[24];
  const uint8_t madValue = s_log.madctl < 0 ? 0x00 : uint8_t(s_log.madctl);
  ws185tune::describeMadctl(madValue, mad, sizeof(mad));
  const uint8_t level = M5.Display.getBrightness();
  size_t len = snprintf(out, n, "panel table=%s gamma=%s E0=", s_log.table, s_log.gammaLabel);
  len = appendHex(out, n, len, pos, ws185tune::kGammaBytes);
  if (len < n) { len += snprintf(out + len, n - len, " E1="); }
  len = appendHex(out, n, len, neg, ws185tune::kGammaBytes);
  if (len < n)
  {
    len += snprintf(out + len, n - len, " inv=%d(%s) madctl=%02X(%s%s) colmod=55 bright=%u duty=%lu/%lu raw=%lu", s_log.inv ? 1 : 0,
                    s_log.inv ? "INVON" : "INVOFF", madValue, mad, s_log.madctl < 0 ? ",init" : "", level,
                    static_cast<unsigned long>(ws185tune::backlightDuty(level)), static_cast<unsigned long>(ws185tune::kBacklightDutyMax),
                    static_cast<unsigned long>(s_log.rawCount));
  }
  const uint32_t kept = s_log.rawCount < 6 ? s_log.rawCount : 6;
  for (uint32_t i = 0; i < kept && len + 12 < n; ++i)
  {
    const auto& r = s_log.raw[(s_log.rawCount - kept + i) % 6];
    len += snprintf(out + len, n - len, i ? ",%02X:%u:%02X" : " last=%02X:%u:%02X", r.cmd, r.n, r.p0);
  }
}
#endif

void ampEnable(bool on)
{
  pinMode(kAmp, OUTPUT);
  digitalWrite(kAmp, on ? HIGH : LOW);
  g_ampOn = on;
}

bool ampIsOn() { return g_ampOn; }

uint8_t es8311Id() { return rd(kEs8311, 0xFD); }

bool dacEnsure() { return writeAll(kEs8311, kEs8311OutputPath, kOutputPathCount); }

bool codecState(char* out, size_t n)
{
  const uint8_t id = es8311Id();
  bool ok = id == kEs8311ChipId;
  int len = snprintf(out, n, "es8311=%02x", id);
  for (size_t i = 0; i < kOutputPathCount && len > 0 && static_cast<size_t>(len) < n; i++)
  {
    const uint8_t v = rd(kEs8311, kEs8311OutputPath[i].reg);
    ok &= v == kEs8311OutputPath[i].val;
    len += snprintf(out + len, n - len, ",r%02x=%02x", kEs8311OutputPath[i].reg, v);
  }
  if (len > 0 && static_cast<size_t>(len) < n) { snprintf(out + len, n - len, ",codec_ok=%d", ok ? 1 : 0); }
  return ok;
}

bool beginAudio()
{
  pinMode(kAmp, OUTPUT);
  digitalWrite(kAmp, LOW);
  g_ampOn = false;
  bool ok = writeAll(kEs8311, kEs8311Init, sizeof(kEs8311Init) / sizeof(Reg));
  // Read the output path back: a write the bus dropped leaves the DAC silent while every digital counter
  // looks healthy (P0 #1063). One retry of the whole table, then the boot journal reports what stuck.
  char state[96];
  if (!codecState(state, sizeof(state)))
  {
    delay(5);
    ok = writeAll(kEs8311, kEs8311Init, sizeof(kEs8311Init) / sizeof(Reg));
    ok &= codecState(state, sizeof(state));
  }
  uint8_t mode = rd(kEs7210, 0x08);
  ok &= wr(kEs7210, 0x08, uint8_t(mode & 0xFE)); // slave
  ok &= writeAll(kEs7210, kEs7210Init, sizeof(kEs7210Init) / sizeof(Reg));

  auto sc = M5.Speaker.config();
  sc.pin_data_out = kI2sDout;
  sc.pin_bck = kI2sBclk;
  sc.pin_ws = kI2sWs;
  sc.pin_mck = kI2sMclk;
  sc.sample_rate = 16000;
  sc.stereo = true;
  sc.i2s_port = I2S_NUM_0;
  M5.Speaker.config(sc); // Speaker's enable callback is protected: callers use ampEnable()

  auto mc = M5.Mic.config();
  mc.pin_data_in = kI2sDin;
  mc.pin_bck = kI2sBclk;
  mc.pin_ws = kI2sWs;
  mc.pin_mck = kI2sMclk;
  mc.sample_rate = 16000;
  // EXPERIMENT (WS185 equal sample pairs): in mono mode M5Unified's mic task treats each FIFO word as
  // two consecutive samples and writes both. The ES7210 on standard I2S puts one real sample in each
  // slot (ADC1 left, ADC2 right), so a mono read yields equal pairs (an effective 8 kHz mic). Reading
  // both slots (stereo) lets M5 average left and right into one distinct sample per frame, the way
  // it is set up for the other ES7210 boards. -DBOB_WS185_MIC_STEREO=0 restores the mono read.
#ifndef BOB_WS185_MIC_STEREO
#define BOB_WS185_MIC_STEREO 1
#endif
  mc.stereo = BOB_WS185_MIC_STEREO != 0;
  // EXPERIMENT (WS185 sample-pair duplication): M5Unified's default over_sampling = 2 re-clocks I2S0
  // to 2 x 16 kHz while the ES7210 is set up for 16 kHz, MCLK 256 x 16 kHz. 1 keeps the bus at
  // exactly 16 kHz. Build with -DBOB_WS185_MIC_OVERSAMPLING=2 to get the old behaviour back.
#ifndef BOB_WS185_MIC_OVERSAMPLING
#define BOB_WS185_MIC_OVERSAMPLING 2
#endif
  mc.over_sampling = BOB_WS185_MIC_OVERSAMPLING;
  mc.i2s_port = I2S_NUM_0;
  M5.Mic.config(mc);
  return ok;
}

// Full-duplex I2S0 for the wake model (#1364). M5Unified installs the port TX-only for the speaker and
// RX-only for the mic, each uninstalling the other; duplexBegin() takes both out and runs one master
// TX|RX driver with the same pins and MCLK as beginAudio().
//
// Gain derivation. M5.Mic (beginAudio(): 16 kHz, stereo, over_sampling 2) turns each stereo frame into
// mix = (L + R) / 2, averages over_sampling consecutive mix values, scales by magnification and clips
// to int16. This path runs the bus at 1x, so it skips the averaging and keeps the same scale, unclipped:
//   out = magnification * (L + R) / 2   (int32)
// The clip is gone on purpose: a mic louder than int16 is the echo the canceller must remove (#1382).
// magnification is read from M5.Mic.config() at duplexBegin().
// Residual, from the 2-sample average M5 applies and this path does not: its magnitude response is
// |cos(pi f / 32 kHz)|, i.e. 0.995 at 1 kHz, 0.92 at 4 kHz, 0.71 at 8 kHz, so speech keeps its level
// within about 0.7 dB; the noise floor is about +3 dB higher (white noise averaged over 2 has half the
// power). With over_sampling 1 there is no residual.
namespace
{
constexpr size_t kDuplexChunkFrames = 160; // 10 ms at 16 kHz
constexpr int kDuplexDmaBufCount = 4;
bool g_duplexOn = false;
int32_t g_micMagnification = 1;
} // namespace

bool duplexBegin(uint32_t rateHz)
{
  if (g_duplexOn) { return true; }
  if (M5.Speaker.isRunning()) { M5.Speaker.end(); }
  if (M5.Mic.isRunning()) { M5.Mic.end(); }
  g_micMagnification = M5.Mic.config().magnification;

  i2s_config_t cfg = {};
  cfg.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_TX | I2S_MODE_RX);
  cfg.sample_rate = rateHz;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags = 0;
  cfg.dma_buf_count = kDuplexDmaBufCount;
  cfg.dma_buf_len = kDuplexChunkFrames;
  cfg.use_apll = false;
  cfg.tx_desc_auto_clear = true;
  cfg.fixed_mclk = 0;
  cfg.mclk_multiple = I2S_MCLK_MULTIPLE_256; // the codecs are set up for MCLK = 256 fs
  cfg.bits_per_chan = I2S_BITS_PER_CHAN_16BIT;
  if (i2s_driver_install(I2S_NUM_0, &cfg, 0, nullptr) != ESP_OK) { return false; }
  i2s_pin_config_t pins = {};
  pins.mck_io_num = kI2sMclk;
  pins.bck_io_num = kI2sBclk;
  pins.ws_io_num = kI2sWs;
  pins.data_out_num = kI2sDout;
  pins.data_in_num = kI2sDin;
  if (i2s_set_pin(I2S_NUM_0, &pins) != ESP_OK)
  {
    i2s_driver_uninstall(I2S_NUM_0);
    return false;
  }
  i2s_zero_dma_buffer(I2S_NUM_0);
  dacEnsure();
  ampEnable(true);
  g_duplexOn = true;
  return true;
}

size_t duplexTransfer(const int16_t* outMono, int32_t* inMono, size_t n, uint32_t timeoutMs)
{
  if (!g_duplexOn) { return 0; }
  size_t done = 0;
  while (done < n)
  {
    const size_t frames = n - done < kDuplexChunkFrames ? n - done : kDuplexChunkFrames;
    int16_t tx[kDuplexChunkFrames * 2];
    int16_t rx[kDuplexChunkFrames * 2];
    for (size_t i = 0; i < frames; i++)
    {
      const int16_t s = outMono[done + i];
      tx[2 * i] = s;
      tx[2 * i + 1] = s;
    }
    size_t written = 0, got = 0;
    i2s_write(I2S_NUM_0, tx, frames * sizeof(tx[0]) * 2, &written, pdMS_TO_TICKS(timeoutMs));
    i2s_read(I2S_NUM_0, rx, frames * sizeof(rx[0]) * 2, &got, pdMS_TO_TICKS(timeoutMs));
    const size_t gotFrames = got / (sizeof(rx[0]) * 2);
    for (size_t i = 0; i < gotFrames; i++)
    {
      inMono[done + i] = ((int32_t(rx[2 * i]) + rx[2 * i + 1]) / 2) * g_micMagnification;
    }
    done += gotFrames;
    if (gotFrames < frames) { break; }
  }
  return done;
}

void duplexEnd()
{
  ampEnable(false);
  if (g_duplexOn) { i2s_driver_uninstall(I2S_NUM_0); }
  g_duplexOn = false;
}

bool duplexActive() { return g_duplexOn; }

touch::Sample touchSample(int16_t* x, int16_t* y)
{
  uint8_t b[5];
  I2cLock lock;
  if (!lock.ok() || !m5::In_I2C.readRegister(kCst816, 0x02, b, sizeof(b), kI2cHz)) { return touch::Sample::kUnknown; }
  return touch::decodeCst816(b, x, y);
}

bool touchPoint(int16_t* x, int16_t* y) { return touchSample(x, y) == touch::Sample::kDown; }

bool bootPressed()
{
  pinMode(kBoot, INPUT_PULLUP);
  return digitalRead(kBoot) == LOW;
}

uint8_t es7210Reg0() { return rd(kEs7210, 0x00); }

#ifdef BOB_TEST_CONSOLE
namespace
{
// One phase of the loopback: `ms` of tone (or zeros) out while the mic is read on the same port; the
// first kSettleMs is discarded. Returns the mic's AC RMS (left and right slots averaged).
float loopbackPhase(bool tone, bool amp, uint32_t* micSamples)
{
  constexpr size_t kFrames = 256;  // stereo frames per block: 16 ms
  int16_t out[kFrames * 2];
  int16_t in[kFrames * 2];
  ampEnable(amp);
  spktest::AcRms rms;
  const uint32_t blocks = spktest::kPhaseMs * spktest::kSampleRateHz / 1000 / kFrames;
  const uint32_t settle = spktest::kSettleMs * spktest::kSampleRateHz / 1000 / kFrames;
  uint32_t t = 0;
  for (uint32_t b = 0; b < blocks; b++)
  {
    for (size_t i = 0; i < kFrames; i++, t++)
    {
      const int16_t s = tone ? spktest::toneSample(t) : 0;
      out[2 * i] = s;
      out[2 * i + 1] = s;
    }
    size_t written = 0, got = 0;
    i2s_write(I2S_NUM_0, out, sizeof(out), &written, pdMS_TO_TICKS(100));
    i2s_read(I2S_NUM_0, in, sizeof(in), &got, pdMS_TO_TICKS(100));
    if (b < settle) { continue; }
    for (size_t i = 0; i + 1 < got / sizeof(int16_t); i += 2) { rms.add((int32_t(in[i]) + in[i + 1]) / 2); }
  }
  *micSamples += rms.count();
  return rms.rms();
}
} // namespace

bool speakerSelfTest(spktest::Levels* levels, uint32_t* micSamples)
{
  *micSamples = 0;
  if (!duplexBegin(spktest::kSampleRateHz)) { return false; }
  levels->quietRms = loopbackPhase(false, true, micSamples);
  levels->ampOffRms = loopbackPhase(true, false, micSamples);
  levels->toneRms = loopbackPhase(true, true, micSamples);
  duplexEnd();  // the next earcon or reply re-installs the speaker
  return true;
}
#endif // BOB_TEST_CONSOLE
} // namespace ws185
} // namespace bob

#endif // BOB_BOARD_WAVESHARE_185C
