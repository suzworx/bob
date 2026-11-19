"""serial-bridge.py - a line pipe between the HIL runner and the Cardputer.

Device serial lines go to stdout (one per line, flushed); every line the
runner writes to stdin goes to the device with a trailing newline. It uses the
pyserial that PlatformIO already installs, so the runner needs nothing new.

`pio device monitor` is not usable for this: its console reads keystrokes
from the terminal, not from a pipe, so a script cannot type into it.

The Cardputer's USB CDC port disappears for a moment whenever the device
resets (after a flash, a crash, a watchdog), so a lost port is reopened until
the runner kills this process. DTR/RTS stay low: on the ESP32-S3's native USB
toggling them can reset the chip or drop it into the bootloader.

Opening the port with both lines low does not reset a running device
(measured 2026-09-23), but the first open after esptool flashed it did, so a
run cannot rely on either. The runner line `@bridge reset` (never sent to the
device) pulses a clean reset instead, so boot-ready always watches a fresh
boot: boot, welcome, READY.

`@bridge pause <ms>` closes the port for <ms> and reopens it (lines low, so
no reset): the host stops reading, which is how the log-backpressure
scenario proves the device's logging never stalls its main loop.

Usage: py -3.11 scripts/hil/serial-bridge.py <port> [baud]
"""

import sys
import threading
import time

import serial  # pyserial, a PlatformIO dependency

PORT = sys.argv[1] if len(sys.argv) > 1 else "COM3"
BAUD = int(sys.argv[2]) if len(sys.argv) > 2 else 115200

lock = threading.Lock()
current = {"port": None}


def status(message):
    # Bridge notices go to stderr so they never mix with device lines.
    sys.stderr.write("[serial-bridge] %s\n" % message)
    sys.stderr.flush()


def open_port():
    while True:
        try:
            port = serial.Serial()
            port.port = PORT
            port.baudrate = BAUD
            port.timeout = 0.2
            port.dtr = False
            port.rts = False
            port.open()
            status("open %s @ %d" % (PORT, BAUD))
            return port
        except (serial.SerialException, OSError) as error:
            status("waiting for %s (%s)" % (PORT, error.__class__.__name__))
            time.sleep(0.5)


RESET_COMMAND = "@bridge reset"


def reset_device():
    # esptool's hard reset: RTS pulls EN low for 200 ms with DTR low (IO0
    # high, so it boots the app, not the bootloader). DTR is written again
    # after each RTS change because Windows only applies RTS with it.
    with lock:
        port = current["port"]
        if port is None:
            status("reset skipped: the port is closed")
            return
        try:
            port.dtr = False
            port.rts = True
            port.dtr = False
            time.sleep(0.2)
            port.rts = False
            port.dtr = False
            status("reset pulse sent")
        except (serial.SerialException, OSError) as error:
            status("reset failed (%s)" % error.__class__.__name__)


PAUSE_PREFIX = "@bridge pause "
MAX_PAUSE_MS = 30000


def writer():
    for line in sys.stdin:
        if line.strip() == RESET_COMMAND:
            reset_device()
            continue
        if line.startswith(PAUSE_PREFIX):
            # The reader closes the port, so the host stops reading: the
            # device's journal must drop lines, never stall (journal.cpp).
            try:
                ms = int(line[len(PAUSE_PREFIX):].strip())
            except ValueError:
                ms = 0
            if 0 < ms <= MAX_PAUSE_MS:
                with lock:
                    current["pause_ms"] = ms
            else:
                status("pause ignored: %r" % line.strip())
            continue
        data = (line.rstrip("\r\n") + "\n").encode("ascii", "replace")
        for _ in range(20):
            with lock:
                port = current["port"]
            try:
                if port is not None:
                    port.write(data)
                    port.flush()
                    break
            except (serial.SerialException, OSError):
                pass
            time.sleep(0.25)
        else:
            status("dropped a command: the port stayed closed")


def main():
    current["port"] = open_port()
    threading.Thread(target=writer, daemon=True).start()
    pending = b""
    while True:
        with lock:
            pause_ms = current.pop("pause_ms", 0)
        if pause_ms:
            with lock:
                try:
                    current["port"].close()
                except Exception:
                    pass
                current["port"] = None
            status("paused: port closed for %d ms" % pause_ms)
            time.sleep(pause_ms / 1000.0)
            port = open_port()  # lines low: reopening does not reset the device.
            with lock:
                current["port"] = port
            continue
        try:
            # Whatever has arrived, at least one byte: read(4096) waited for
            # 4096 bytes or the whole 0.2 s timeout, so every device line
            # reached the runner up to 200 ms late. A "100 ms" GO tap then
            # lasted 300+ ms on the device and became a real turn (HIL run
            # 20260924-082431-3e28, go-tap-ignored).
            port = current["port"]
            chunk = port.read(max(1, port.in_waiting))
        except (serial.SerialException, OSError):
            status("port lost; reopening")
            with lock:
                try:
                    current["port"].close()
                except Exception:
                    pass
                current["port"] = None
            port = open_port()
            with lock:
                current["port"] = port
            continue
        if not chunk:
            continue
        pending += chunk
        *lines, pending = pending.split(b"\n")
        for raw in lines:
            sys.stdout.write(raw.decode("utf-8", "replace").rstrip("\r") + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
