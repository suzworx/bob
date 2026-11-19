/*----------------------------------------------------------------------------/
  ST77916 QSPI panel for the Waveshare ESP32-S3-Touch-LCD-1.85C (360x360 round).

  Vendored from LovyanGFX 1.2.26, src/lgfx/v1/panel/Panel_ST77916.{hpp,inl}.
  LovyanGFX cannot be linked next to M5GFX (both define lgfx::v1), so this is
  the same panel class built against M5GFX 0.2.27's lgfx::v1 headers and its
  QSPI Bus_SPI. Changes from upstream: header-only (inline definitions), the
  init table is Waveshare's vendor_specific_init_new[] (ESP32-S3-Touch-LCD-1.85C,
  Arduino/examples/01_lvgl_example/Display_ST77916.cpp), with its 0x21 moved out
  of the table: inversion is ON for this panel and is sent from cfg.invert; no
  readback; writeImage always converts line by line through the DMA buffer.

  Lessons for the next board port (checked against the reference port of this board,
  facebookincubator/muse-gadget-sdk @fa07304: board_waveshare_s3_185c.c,
  st77916_init_185c.h, muse_lcd_bands.c; its init table is MIT from 78/xiaozhi-esp32):
   - Init table: byte-identical to ours except where 0x21 goes. Inversion must be ON
     (INVON): setInvert() XORs with cfg.invert as Panel_LCD does, because M5GFX calls
     setInvert(false) after init() and a plain 0x20 undid cfg.invert = true.
   - Colour: RGB order (MADCTL BGR bit clear), COLMOD 0x55, pixels as big-endian RGB565
     (lgfx::swap565_t), the same order fills and sprites use. No byte swap anywhere else.
   - RAMWR: one 0x32 0x00 0x2C 0x00 frame per window. Starting it again per row (as the
     upstream per-row write_bytes did) restarts at the first row and collapses an image
     into one line; writeImage sends all rows under a single start_qspi().
   - Even windows: the reference's band sender keeps windows even, but that is the CO5300
     rule its comment cites, not an ST77916 one. Not applied here: rounding a window
     outward would paint pixels nobody asked for.
   - DMA source: SPI DMA cannot read PSRAM or flash. The reference copies 360 x 8 x 2 B
     pieces into internal DMA buffers; send_pixels() does the same in 2 KB pieces for any
     source that is not DMA-capable (a PSRAM sprite, a .rodata image).
   - Clock: 80 MHz gave speckled pixels on the V2 board, 40 MHz is clean.
   - Dark colours looked brighter than their value (navy #173E57 read as mid-blue) while
     saturated fills were right: suspect the panel gamma (init table E0/E1) before the
     pixel path. Not resolved here; the waveshare-s3-185c-swatch env shows it. Waveshare's demo picks
     its table by RDDID (00 02 7F 7F -> this table, 00 7F 7F 7F -> espDefaultInitCommands below); we
     never read the ID. docs/waveshare/navy-1065.md has the hil commands that test it live (#1065).

  Original Source:
   https://github.com/lovyan03/LovyanGFX/

  Licence:
   [FreeBSD](https://github.com/lovyan03/LovyanGFX/blob/master/license.txt)

  Author:
   [Christian Erhardt](https://github.com/MoJo2600) (ST77916 support)
   lovyan03 / ciniml / tobozo (QSPI plumbing)
/----------------------------------------------------------------------------*/
#pragma once

#if defined(BOB_BOARD_WAVESHARE_185C)

#include <M5GFX.h>

namespace lgfx
{
inline namespace v1
{
struct Panel_ST77916 : public Panel_Device
{
  Panel_ST77916(void)
  {
    _cfg.panel_width = _cfg.memory_width = 360;
    _cfg.panel_height = _cfg.memory_height = 360;
    _cfg.dummy_read_pixel = 8;
  }

  bool init(bool use_reset) override;
  void beginTransaction(void) override;
  void endTransaction(void) override;
  color_depth_t setColorDepth(color_depth_t depth) override;
  void setRotation(uint_fast8_t r) override;
  void setInvert(bool invert) override;
  void setSleep(bool flg) override;
  void setPowerSave(bool) override {}
  void waitDisplay(void) override { _bus->wait(); }
  // Sends one raw command with up to 16 parameter bytes (the hil console's `T panel`, for gamma and
  // inversion experiments on the glass).
  void sendRaw(uint8_t cmd, const uint8_t* params, uint8_t n);
  // hil console only (#1065, `T panel init` / `T panel id`): run a whole init table again and restore
  // MADCTL, COLMOD and INVON as init() does; read RDDID (0x04) as Waveshare's demo does to pick a table.
  void reinit(bool espDefault);
  void readDisplayId(uint8_t id[4]);
  bool displayBusy(void) override { return false; }
  void writePixels(pixelcopy_t* param, uint32_t len, bool use_dma) override;
  void writeBlock(uint32_t rawcolor, uint32_t len) override;
  void setWindow(uint_fast16_t xs, uint_fast16_t ys, uint_fast16_t xe, uint_fast16_t ye) override;
  void drawPixelPreclipped(uint_fast16_t x, uint_fast16_t y, uint32_t rawcolor) override;
  void writeFillRectPreclipped(uint_fast16_t x, uint_fast16_t y, uint_fast16_t w, uint_fast16_t h, uint32_t rawcolor) override;
  void writeImage(uint_fast16_t x, uint_fast16_t y, uint_fast16_t w, uint_fast16_t h, pixelcopy_t* param, bool use_dma) override;
  uint32_t readCommand(uint_fast16_t, uint_fast8_t, uint_fast8_t) override { return 0; }
  uint32_t readData(uint_fast8_t, uint_fast8_t) override { return 0; }
  void readRect(uint_fast16_t, uint_fast16_t, uint_fast16_t, uint_fast16_t, void*, pixelcopy_t*) override {}

protected:
  bool _in_transaction = false;
  uint16_t _colstart = 0;
  uint16_t _rowstart = 0;

  void command_list(const uint8_t* addr);
  void update_madctl(void);
  void write_cmd(uint8_t cmd);
  void start_qspi(void);
  void write_bytes(const uint8_t* data, uint32_t len, bool use_dma);
  void send_pixels(const uint8_t* data, uint32_t len, bool use_dma);
  static const uint8_t* initCommands(void);
  static const uint8_t* espDefaultInitCommands(void);
};

// Entries are {cmd, nparams [| CMD_INIT_DELAY], params..., [delay ms]}, ended by {0xFF, 0xFF}.
inline const uint8_t* Panel_ST77916::initCommands(void)
{
  static constexpr uint8_t list0[] = {
    0xF0,1,0x28, 0xF2,1,0x28, 0x73,1,0xF0, 0x7C,1,0xD1, 0x83,1,0xE0, 0x84,1,0x61, 0xF2,1,0x82,
    0xF0,1,0x00, 0xF0,1,0x01, 0xF1,1,0x01,
    0xB0,1,0x56, 0xB1,1,0x4D, 0xB2,1,0x24, 0xB4,1,0x87, 0xB5,1,0x44, 0xB6,1,0x8B, 0xB7,1,0x40,
    0xB8,1,0x86, 0xBA,1,0x00, 0xBB,1,0x08, 0xBC,1,0x08, 0xBD,1,0x00,
    0xC0,1,0x80, 0xC1,1,0x10, 0xC2,1,0x37, 0xC3,1,0x80, 0xC4,1,0x10, 0xC5,1,0x37, 0xC6,1,0xA9,
    0xC7,1,0x41, 0xC8,1,0x01, 0xC9,1,0xA9, 0xCA,1,0x41, 0xCB,1,0x01,
    0xD0,1,0x91, 0xD1,1,0x68, 0xD2,1,0x68, 0xF5,2,0x00,0xA5, 0xDD,1,0x4F, 0xDE,1,0x4F,
    0xF1,1,0x10, 0xF0,1,0x00, 0xF0,1,0x02,
    0xE0,14,0xF0,0x0A,0x10,0x09,0x09,0x36,0x35,0x33,0x4A,0x29,0x15,0x15,0x2E,0x34,
    0xE1,14,0xF0,0x0A,0x0F,0x08,0x08,0x05,0x34,0x33,0x4A,0x39,0x15,0x15,0x2D,0x33,
    0xF0,1,0x10, 0xF3,1,0x10,
    0xE0,1,0x07, 0xE1,1,0x00, 0xE2,1,0x00, 0xE3,1,0x00, 0xE4,1,0xE0, 0xE5,1,0x06, 0xE6,1,0x21,
    0xE7,1,0x01, 0xE8,1,0x05, 0xE9,1,0x02, 0xEA,1,0xDA, 0xEB,1,0x00, 0xEC,1,0x00, 0xED,1,0x0F,
    0xEE,1,0x00, 0xEF,1,0x00, 0xF8,1,0x00, 0xF9,1,0x00, 0xFA,1,0x00, 0xFB,1,0x00, 0xFC,1,0x00,
    0xFD,1,0x00, 0xFE,1,0x00, 0xFF,1,0x00,
    0x60,1,0x40, 0x61,1,0x04, 0x62,1,0x00, 0x63,1,0x42, 0x64,1,0xD9, 0x65,1,0x00, 0x66,1,0x00,
    0x67,1,0x00, 0x68,1,0x00, 0x69,1,0x00, 0x6A,1,0x00, 0x6B,1,0x00,
    0x70,1,0x40, 0x71,1,0x03, 0x72,1,0x00, 0x73,1,0x42, 0x74,1,0xD8, 0x75,1,0x00, 0x76,1,0x00,
    0x77,1,0x00, 0x78,1,0x00, 0x79,1,0x00, 0x7A,1,0x00, 0x7B,1,0x00,
    0x80,1,0x48, 0x81,1,0x00, 0x82,1,0x06, 0x83,1,0x02, 0x84,1,0xD6, 0x85,1,0x04, 0x86,1,0x00, 0x87,1,0x00,
    0x88,1,0x48, 0x89,1,0x00, 0x8A,1,0x08, 0x8B,1,0x02, 0x8C,1,0xD8, 0x8D,1,0x04, 0x8E,1,0x00, 0x8F,1,0x00,
    0x90,1,0x48, 0x91,1,0x00, 0x92,1,0x0A, 0x93,1,0x02, 0x94,1,0xDA, 0x95,1,0x04, 0x96,1,0x00, 0x97,1,0x00,
    0x98,1,0x48, 0x99,1,0x00, 0x9A,1,0x0C, 0x9B,1,0x02, 0x9C,1,0xDC, 0x9D,1,0x04, 0x9E,1,0x00, 0x9F,1,0x00,
    0xA0,1,0x48, 0xA1,1,0x00, 0xA2,1,0x05, 0xA3,1,0x02, 0xA4,1,0xD5, 0xA5,1,0x04, 0xA6,1,0x00, 0xA7,1,0x00,
    0xA8,1,0x48, 0xA9,1,0x00, 0xAA,1,0x07, 0xAB,1,0x02, 0xAC,1,0xD7, 0xAD,1,0x04, 0xAE,1,0x00, 0xAF,1,0x00,
    0xB0,1,0x48, 0xB1,1,0x00, 0xB2,1,0x09, 0xB3,1,0x02, 0xB4,1,0xD9, 0xB5,1,0x04, 0xB6,1,0x00, 0xB7,1,0x00,
    0xB8,1,0x48, 0xB9,1,0x00, 0xBA,1,0x0B, 0xBB,1,0x02, 0xBC,1,0xDB, 0xBD,1,0x04, 0xBE,1,0x00, 0xBF,1,0x00,
    0xC0,1,0x10, 0xC1,1,0x47, 0xC2,1,0x56, 0xC3,1,0x65, 0xC4,1,0x74, 0xC5,1,0x88, 0xC6,1,0x99, 0xC7,1,0x01,
    0xC8,1,0xBB, 0xC9,1,0xAA,
    0xD0,1,0x10, 0xD1,1,0x47, 0xD2,1,0x56, 0xD3,1,0x65, 0xD4,1,0x74, 0xD5,1,0x88, 0xD6,1,0x99, 0xD7,1,0x01,
    0xD8,1,0xBB, 0xD9,1,0xAA,
    0xF3,1,0x01, 0xF0,1,0x00,
    // INVON before sleep-out, exactly where Waveshare's table and the muse-gadget-sdk port
    // (esp32/components/muse/boards/waveshare_s3_185c/st77916_init_185c.h @fa07304, MIT, from
    // 78/xiaozhi-esp32) put it. It used to be sent only after display-on; init() still sends it
    // again from cfg.invert (true), which is harmless. MADCTL and COLMOD follow in init().
    0x21,1,0x00,
    0x11,1 + CMD_INIT_DELAY,0x00,120, // sleep out
    0x29,1,0x00,                 // display on
    0xFF,0xFF,
  };
  return list0;
}

// Espressif esp_lcd_st77916 vendor_specific_init_default (esp-iot-solution, esp_lcd_st77916_spi.c),
// converted one-for-one by script: the table Waveshare's own demo (Display_ST77916.cpp) sends when
// RDDID reads 00 7F 7F 7F instead of 00 02 7F 7F. Different VRHP/VRHN/VCOM (B0-B2), VCOM offset (DD/DE),
// gamma (E0/E1) and GIP page from the table above. It ends with a RAM clear (4C) to black, INVON,
// sleep-out and display-on. Never sent unless `T panel init esp` is typed (#1065).
inline const uint8_t* Panel_ST77916::espDefaultInitCommands(void)
{
  static constexpr uint8_t list[] = {
    0xF0,1,0x08, 0xF2,1,0x08, 0x9B,1,0x51, 0x86,1,0x53, 0xF2,1,0x80, 0xF0,1,0x00, 0xF0,1,0x01, 0xF1,1,0x01,
    0xB0,1,0x54, 0xB1,1,0x3F, 0xB2,1,0x2A, 0xB4,1,0x46, 0xB5,1,0x34, 0xB6,1,0xD5, 0xB7,1,0x30, 0xB8,1,0x04,
    0xBA,1,0x00, 0xBB,1,0x08, 0xBC,1,0x08, 0xBD,1,0x00, 0xC0,1,0x80, 0xC1,1,0x10, 0xC2,1,0x37, 0xC3,1,0x80,
    0xC4,1,0x10, 0xC5,1,0x37, 0xC6,1,0xA9, 0xC7,1,0x41, 0xC8,1,0x51, 0xC9,1,0xA9, 0xCA,1,0x41, 0xCB,1,0x51,
    0xD0,1,0x91, 0xD1,1,0x68, 0xD2,1,0x69, 0xF5,2,0x00,0xA5, 0xDD,1,0x35, 0xDE,1,0x35, 0xF1,1,0x10,
    0xF0,1,0x00, 0xF0,1,0x02, 0xE0,14,0x70,0x09,0x12,0x0C,0x0B,0x27,0x38,0x54,0x4E,0x19,0x15,0x15,0x2C,0x2F,
    0xE1,14,0x70,0x08,0x11,0x0C,0x0B,0x27,0x38,0x43,0x4C,0x18,0x14,0x14,0x2B,0x2D, 0xF0,1,0x10, 0xF3,1,0x10,
    0xE0,1,0x0A, 0xE1,1,0x00, 0xE2,1,0x0B, 0xE3,1,0x00, 0xE4,1,0xE0, 0xE5,1,0x06, 0xE6,1,0x21, 0xE7,1,0x00,
    0xE8,1,0x05, 0xE9,1,0x82, 0xEA,1,0xDF, 0xEB,1,0x89, 0xEC,1,0x20, 0xED,1,0x14, 0xEE,1,0xFF, 0xEF,1,0x00,
    0xF8,1,0xFF, 0xF9,1,0x00, 0xFA,1,0x00, 0xFB,1,0x30, 0xFC,1,0x00, 0xFD,1,0x00, 0xFE,1,0x00, 0xFF,1,0x00,
    0x60,1,0x42, 0x61,1,0xE0, 0x62,1,0x40, 0x63,1,0x40, 0x64,1,0x02, 0x65,1,0x00, 0x66,1,0x40, 0x67,1,0x03,
    0x68,1,0x00, 0x69,1,0x00, 0x6A,1,0x00, 0x6B,1,0x00, 0x70,1,0x42, 0x71,1,0xE0, 0x72,1,0x40, 0x73,1,0x40,
    0x74,1,0x02, 0x75,1,0x00, 0x76,1,0x40, 0x77,1,0x03, 0x78,1,0x00, 0x79,1,0x00, 0x7A,1,0x00, 0x7B,1,0x00,
    0x80,1,0x38, 0x81,1,0x00, 0x82,1,0x04, 0x83,1,0x02, 0x84,1,0xDC, 0x85,1,0x00, 0x86,1,0x00, 0x87,1,0x00,
    0x88,1,0x38, 0x89,1,0x00, 0x8A,1,0x06, 0x8B,1,0x02, 0x8C,1,0xDE, 0x8D,1,0x00, 0x8E,1,0x00, 0x8F,1,0x00,
    0x90,1,0x38, 0x91,1,0x00, 0x92,1,0x08, 0x93,1,0x02, 0x94,1,0xE0, 0x95,1,0x00, 0x96,1,0x00, 0x97,1,0x00,
    0x98,1,0x38, 0x99,1,0x00, 0x9A,1,0x0A, 0x9B,1,0x02, 0x9C,1,0xE2, 0x9D,1,0x00, 0x9E,1,0x00, 0x9F,1,0x00,
    0xA0,1,0x38, 0xA1,1,0x00, 0xA2,1,0x03, 0xA3,1,0x02, 0xA4,1,0xDB, 0xA5,1,0x00, 0xA6,1,0x00, 0xA7,1,0x00,
    0xA8,1,0x38, 0xA9,1,0x00, 0xAA,1,0x05, 0xAB,1,0x02, 0xAC,1,0xDD, 0xAD,1,0x00, 0xAE,1,0x00, 0xAF,1,0x00,
    0xB0,1,0x38, 0xB1,1,0x00, 0xB2,1,0x07, 0xB3,1,0x02, 0xB4,1,0xDF, 0xB5,1,0x00, 0xB6,1,0x00, 0xB7,1,0x00,
    0xB8,1,0x38, 0xB9,1,0x00, 0xBA,1,0x09, 0xBB,1,0x02, 0xBC,1,0xE1, 0xBD,1,0x00, 0xBE,1,0x00, 0xBF,1,0x00,
    0xC0,1,0x22, 0xC1,1,0xAA, 0xC2,1,0x65, 0xC3,1,0x74, 0xC4,1,0x47, 0xC5,1,0x56, 0xC6,1,0x00, 0xC7,1,0x88,
    0xC8,1,0x99, 0xC9,1,0x33, 0xD0,1,0x11, 0xD1,1,0xAA, 0xD2,1,0x65, 0xD3,1,0x74, 0xD4,1,0x47, 0xD5,1,0x56,
    0xD6,1,0x00, 0xD7,1,0x88, 0xD8,1,0x99, 0xD9,1,0x33, 0xF3,1,0x01, 0xF0,1,0x00, 0xF0,1,0x01, 0xF1,1,0x01,
    0xA0,1,0x0B, 0xA3,1,0x2A, 0xA5,1 + CMD_INIT_DELAY,0xC3,1, 0xA3,1,0x2B, 0xA5,1 + CMD_INIT_DELAY,0xC3,1,
    0xA3,1,0x2C, 0xA5,1 + CMD_INIT_DELAY,0xC3,1, 0xA3,1,0x2D, 0xA5,1 + CMD_INIT_DELAY,0xC3,1, 0xA3,1,0x2E,
    0xA5,1 + CMD_INIT_DELAY,0xC3,1, 0xA3,1,0x2F, 0xA5,1 + CMD_INIT_DELAY,0xC3,1, 0xA3,1,0x30,
    0xA5,1 + CMD_INIT_DELAY,0xC3,1, 0xA3,1,0x31, 0xA5,1 + CMD_INIT_DELAY,0xC3,1, 0xA3,1,0x32,
    0xA5,1 + CMD_INIT_DELAY,0xC3,1, 0xA3,1,0x33, 0xA5,1 + CMD_INIT_DELAY,0xC3,1, 0xA0,1,0x09, 0xF1,1,0x10,
    0xF0,1,0x00, 0x2A,4,0x00,0x00,0x01,0x67, 0x2B,4,0x01,0x68,0x01,0x68, 0x4D,1,0x00, 0x4E,1,0x00,
    0x4F,1,0x00, 0x4C,1 + CMD_INIT_DELAY,0x01,10, 0x4C,1,0x00, 0x2A,4,0x00,0x00,0x01,0x67,
    0x2B,4,0x00,0x00,0x01,0x67, 0x21,1,0x00, 0x11,1 + CMD_INIT_DELAY,0x00,120,
    0x29,1,0x00, // display on (esp_lcd sends it separately, from disp_on_off)
    0xFF,0xFF,
  };
  return list;
}

// MADCTL base per rotation (mirror/exchange bits); the colour-order bit is added from cfg.rgb_order.
static constexpr uint8_t kSt77916Madctl[8] = {0x00, 0x60, 0xC0, 0xA0, 0x80, 0x20, 0x40, 0xE0};

inline void Panel_ST77916::write_cmd(uint8_t cmd)
{
  // QSPI command frame on the wire: 0x02 0x00 <cmd> 0x00, CS cycled around it.
  _bus->wait();
  cs_control(true);
  const uint8_t frame[4] = {0x02, 0x00, cmd, 0x00};
  cs_control(false);
  for (int i = 0; i < 4; i++) { _bus->writeCommand(frame[i], 8); }
}

inline void Panel_ST77916::start_qspi(void)
{
  // RAMWR as ONE 32-bit frame: 0x32 0x00 0x2C 0x00, so the SPI peripheral delimits
  // the command phase before the 4-wire pixel phase.
  _bus->wait();
  cs_control(true);
  cs_control(false);
  _bus->writeCommand(0x002C0032, 32);
}

inline void Panel_ST77916::write_bytes(const uint8_t* data, uint32_t len, bool use_dma)
{
  start_qspi();
  _bus->writeBytes(data, len, true, use_dma);
}

// Pixel bytes inside an open RAMWR. SPI DMA reads internal RAM only, so a source in PSRAM or
// flash is copied through the bus's internal DMA buffer in pieces (the reference port for this
// board does the same, 360 x 8 x 2 B at a time) instead of handing the bus a pointer it cannot DMA.
inline void Panel_ST77916::send_pixels(const uint8_t* data, uint32_t len, bool use_dma)
{
  if (use_dma && esp_ptr_dma_capable(data)) { _bus->writeBytes(data, len, true, true); return; }
  constexpr uint32_t kPiece = 2048;
  while (len)
  {
    const uint32_t n = len < kPiece ? len : kPiece;
    auto buf = _bus->getDMABuffer(n);
    if (!buf) { return; }
    memcpy(buf, data, n);
    _bus->writeBytes(buf, n, true, true);
    data += n;
    len -= n;
  }
}

inline void Panel_ST77916::command_list(const uint8_t* addr)
{
  startWrite();
  for (;;)
  {
    uint8_t cmd = *addr++;
    uint8_t num = *addr++;
    if (cmd == 0xFF && num == 0xFF) { break; }
    write_cmd(cmd);
    uint_fast8_t ms = num & CMD_INIT_DELAY;
    num &= ~CMD_INIT_DELAY;
    while (num--) { _bus->writeCommand(*addr++, 8); }
    _bus->wait();
    if (ms)
    {
      ms = *addr++;
      cs_control(true);
      delay(ms == 255 ? 500 : ms);
      cs_control(false);
    }
  }
  _bus->wait();
  cs_control(true);
  endWrite();
}

inline void Panel_ST77916::sendRaw(uint8_t cmd, const uint8_t* params, uint8_t n)
{
  uint8_t list[2 + 16 + 2];
  if (n > 16) { n = 16; }
  list[0] = cmd;
  list[1] = n;
  for (uint8_t i = 0; i < n; ++i) { list[2 + i] = params[i]; }
  list[2 + n] = 0xFF;
  list[3 + n] = 0xFF;
  command_list(list);
}

inline void Panel_ST77916::reinit(bool espDefault)
{
  command_list(espDefault ? espDefaultInitCommands() : initCommands());
  update_madctl();
  setColorDepth(rgb565_2Byte);
  setInvert(false); // INVON, as init() leaves it
}

// RDDID the way Waveshare's demo reads it: opcode 0x0B, command 0x04 as a 32-bit single-line frame,
// then 4 bytes clocked in on IO1 at the bus's read clock (5 MHz, as the demo's probe). Best effort:
// this bus is wired for writes, so 00 00 00 00 or FF FF FF FF means "no answer", not a panel ID.
inline void Panel_ST77916::readDisplayId(uint8_t id[4])
{
  startWrite();
  _bus->wait();
  cs_control(true);
  cs_control(false);
  _bus->writeCommand(0x0004000B, 32); // bytes on the wire: 0B 00 04 00
  _bus->wait();
  _bus->beginRead();
  const uint32_t v = _bus->readData(32);
  _bus->endRead();
  cs_control(true);
  endWrite();
  for (int i = 0; i < 4; ++i) { id[i] = uint8_t(v >> (8 * i)); }
}

inline void Panel_ST77916::update_madctl(void)
{
  const uint8_t cmds[] = {0x36, 1, uint8_t(kSt77916Madctl[_internal_rotation & 7] | (_cfg.rgb_order ? 0x00 : 0x08)), 0xFF, 0xFF};
  command_list(cmds);
}

inline bool Panel_ST77916::init(bool use_reset)
{
  if (!Panel_Device::init(use_reset)) { return false; }
  command_list(initCommands());
  update_madctl();
  setColorDepth(rgb565_2Byte);
  setInvert(false); // XOR with cfg.invert: INVON when cfg.invert is true
  return true;
}

inline color_depth_t Panel_ST77916::setColorDepth(color_depth_t depth)
{
  uint8_t fmt = 0;
  if (depth == rgb565_2Byte) { fmt = 0x55; }
  else if (depth == rgb666_3Byte) { fmt = 0x66; }
  else { return _write_depth; }
  _write_depth = _read_depth = depth;
  _write_bits = _read_bits = ((int)depth & color_depth_t::bit_mask);
  const uint8_t cmds[] = {0x3A, 1, fmt, 0xFF, 0xFF};
  command_list(cmds);
  return _write_depth;
}

inline void Panel_ST77916::setRotation(uint_fast8_t r)
{
  r &= 7;
  _rotation = r;
  _internal_rotation = ((r + _cfg.offset_rotation) & 3) | ((r & 4) ^ (_cfg.offset_rotation & 4));
  auto ox = _cfg.offset_x, oy = _cfg.offset_y, pw = _cfg.panel_width, ph = _cfg.panel_height;
  auto mw = _cfg.memory_width, mh = _cfg.memory_height;
  if (_internal_rotation & 1) { std::swap(ox, oy); std::swap(pw, ph); std::swap(mw, mh); }
  _width = pw;
  _height = ph;
  _colstart = (_internal_rotation & 2) ? mw - (pw + ox) : ox;
  _rowstart = ((1 << _internal_rotation) & 0b10010110) ? mh - (ph + oy) : oy;
  _xs = _xe = _ys = _ye = INT16_MAX;
  update_madctl();
}

inline void Panel_ST77916::setInvert(bool invert)
{
  // XOR with cfg.invert as Panel_LCD does: M5GFX calls setInvert(false) after init(), and
  // that must keep the panel's native inversion (cfg.invert = true -> INVON).
  const uint8_t cmds[] = {uint8_t((invert ^ _cfg.invert) ? 0x21 : 0x20), 0, 0xFF, 0xFF};
  command_list(cmds);
}

inline void Panel_ST77916::setSleep(bool flg)
{
  const uint8_t on[] = {0x11, 0, 0xFF, 0xFF};
  const uint8_t off[] = {0x10, 0, 0xFF, 0xFF};
  command_list(flg ? off : on);
  if (!flg) { delay(120); }
}

inline void Panel_ST77916::beginTransaction(void)
{
  if (_in_transaction) { return; }
  _in_transaction = true;
  _bus->beginTransaction();
}

inline void Panel_ST77916::endTransaction(void)
{
  if (!_in_transaction) { return; }
  _in_transaction = false;
  if (_has_align_data)
  {
    _has_align_data = false;
    _bus->writeData(0, 8);
  }
  _bus->wait();
  cs_control(true);
  _bus->endTransaction();
}

inline void Panel_ST77916::setWindow(uint_fast16_t xs, uint_fast16_t ys, uint_fast16_t xe, uint_fast16_t ye)
{
  if ((xe - xs) >= _width) { xs = 0; xe = _width - 1; }
  if ((ye - ys) >= _height) { ys = 0; ye = _height - 1; }
  xs += _colstart; xe += _colstart;
  ys += _rowstart; ye += _rowstart;
  // Address bytes go out as one big-endian 32-bit word after the command frame.
  write_cmd(0x2A);
  _bus->writeCommand(__builtin_bswap32((uint32_t)xs << 16 | xe), 32);
  write_cmd(0x2B);
  _bus->writeCommand(__builtin_bswap32((uint32_t)ys << 16 | ye), 32);
  _bus->wait();
}

inline void Panel_ST77916::writeBlock(uint32_t rawcolor, uint32_t len)
{
  start_qspi();
  _bus->writeDataRepeat(rawcolor, _write_bits, len);
}

inline void Panel_ST77916::writePixels(pixelcopy_t* param, uint32_t len, bool use_dma)
{
  start_qspi();
  if (param->no_convert) {
    send_pixels(reinterpret_cast<const uint8_t*>(param->src_data), len * _write_bits >> 3, use_dma);
  } else {
    _bus->writePixels(param, len);
  }
  _bus->wait();
}

inline void Panel_ST77916::drawPixelPreclipped(uint_fast16_t x, uint_fast16_t y, uint32_t rawcolor)
{
  setWindow(x, y, x, y);
  start_qspi();
  _bus->writeData(rawcolor, _write_bits);
}

inline void Panel_ST77916::writeFillRectPreclipped(uint_fast16_t x, uint_fast16_t y, uint_fast16_t w, uint_fast16_t h, uint32_t rawcolor)
{
  setWindow(x, y, x + w - 1, y + h - 1);
  start_qspi();
  _bus->writeDataRepeat(rawcolor, _write_bits, w * h);
}

// One converted line at a time through the bus DMA buffer: handles every source
// format, transparency and stride without upstream's special cases.
inline void Panel_ST77916::writeImage(uint_fast16_t x, uint_fast16_t y, uint_fast16_t w, uint_fast16_t h, pixelcopy_t* param, bool use_dma)
{
  const uint32_t bytes = param->dst_bits >> 3;
  const auto src_x = param->src_x;
  if (param->transp == pixelcopy_t::NON_TRANSP)
  {
    setWindow(x, y, x + w - 1, y + h - 1);
    if (param->no_convert)
    {
      // Same format as the panel: send the rows as they are (bounced through internal RAM when
      // the source is PSRAM or flash, see send_pixels).
      auto src = static_cast<const uint8_t*>(param->src_data) + (src_x + param->src_y * param->src_bitwidth) * bytes;
      // One RAMWR for the whole window: a second 0x2C would restart at the window's first row.
      start_qspi();
      for (uint_fast16_t row = 0; row < h; row++, src += param->src_bitwidth * bytes) { send_pixels(src, w * bytes, use_dma); }
      return;
    }
    start_qspi();
    for (uint_fast16_t row = 0; row < h; row++)
    {
      auto buf = _bus->getDMABuffer(w * bytes);
      if (!buf) { return; }
      param->src_x = src_x;
      param->fp_copy(buf, 0, w, param);
      _bus->writeBytes(buf, w * bytes, true, true);
      param->src_y++;
    }
    return;
  }
  for (uint_fast16_t row = 0; row < h; row++, y++)
  {
    uint32_t i = 0;
    while (w != (i = param->fp_skip(i, w, param)))
    {
      auto buf = _bus->getDMABuffer(w * bytes);
      if (!buf) { return; }
      const int32_t len = param->fp_copy(buf, 0, w - i, param);
      setWindow(x + i, y, x + i + len - 1, y);
      write_bytes(buf, len * bytes, true);
      if (w == (i += len)) { break; }
    }
    param->src_x = src_x;
    param->src_y++;
  }
}

} // namespace v1
} // namespace lgfx

#endif // BOB_BOARD_WAVESHARE_185C
