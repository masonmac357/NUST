#!/usr/bin/env python3
"""YT Mic: play YouTube audio through a virtual microphone.

The app decodes a YouTube video's audio with yt-dlp + ffmpeg and plays it into
a virtual audio cable (VB-CABLE on Windows, BlackHole on macOS, a PipeWire/Pulse
null sink on Linux). In a game, pick the cable's *output/recording* side as your
microphone and everyone in voice chat hears the audio. Your real microphone can
be mixed in so you can still talk, and the audio can also be sent to your
headphones so you hear what you're playing.

Run:  python yt_mic.py            (GUI)
      python yt_mic.py --list     (print audio devices)
"""

from __future__ import annotations

import argparse
import queue
import shutil
import subprocess
import sys
import threading
import time
from collections import deque

import numpy as np
import sounddevice as sd

RATE = 48000
CHANNELS = 2
BLOCK = 1024  # frames per read from ffmpeg (~21 ms)
COOKIE_BROWSER: str | None = None  # e.g. "chrome", set by --browser


# --------------------------------------------------------------------------- #
# Audio plumbing
# --------------------------------------------------------------------------- #
class FrameBuffer:
    """Thread-safe FIFO of stereo float32 frames.

    Writers can block when the buffer is full (used to pace the decoder to the
    real-time speed of the cable device) or drop the oldest audio (used for
    secondary outputs and the mic so they never fall behind).
    """

    def __init__(self, max_frames: int):
        self.max_frames = max_frames
        self._chunks: deque[np.ndarray] = deque()
        self._size = 0
        self._cond = threading.Condition()

    def write(self, data: np.ndarray, block: bool, stop: threading.Event | None = None):
        with self._cond:
            if block:
                while self._size + len(data) > self.max_frames:
                    if stop is not None and stop.is_set():
                        return
                    self._cond.wait(0.05)
            self._chunks.append(data)
            self._size += len(data)
            while self._size > self.max_frames and self._chunks:
                dropped = self._chunks.popleft()
                self._size -= len(dropped)

    def read(self, n: int) -> np.ndarray:
        """Return exactly n frames, zero-padded if not enough are buffered."""
        out = np.zeros((n, CHANNELS), dtype=np.float32)
        filled = 0
        with self._cond:
            while filled < n and self._chunks:
                chunk = self._chunks[0]
                take = min(n - filled, len(chunk))
                out[filled:filled + take] = chunk[:take]
                filled += take
                if take == len(chunk):
                    self._chunks.popleft()
                else:
                    self._chunks[0] = chunk[take:]
                self._size -= take
            self._cond.notify_all()
        return out

    def clear(self):
        with self._cond:
            self._chunks.clear()
            self._size = 0
            self._cond.notify_all()

    def __len__(self):
        return self._size


def to_stereo(data: np.ndarray) -> np.ndarray:
    if data.shape[1] == CHANNELS:
        return data.astype(np.float32, copy=True)
    if data.shape[1] == 1:
        return np.repeat(data, CHANNELS, axis=1).astype(np.float32)
    return data[:, :CHANNELS].astype(np.float32, copy=True)


def resolve_stream(query: str) -> tuple[str, str]:
    """Turn a URL or search text into (direct audio URL, title) via yt-dlp."""
    import yt_dlp

    target = query.strip()
    if not target.startswith(("http://", "https://")):
        target = f"ytsearch1:{target}"
    opts = {"format": "bestaudio/best", "quiet": True, "noplaylist": True, "no_warnings": True}
    if COOKIE_BROWSER:
        opts["cookiesfrombrowser"] = (COOKIE_BROWSER,)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(target, download=False)
    if "entries" in info:  # search result
        entries = [e for e in info["entries"] if e]
        if not entries:
            raise RuntimeError("No results found.")
        info = entries[0]
    return info["url"], info.get("title", "Unknown title")


class Player:
    """Decodes one track and mixes it (plus optional mic) to the outputs."""

    def __init__(self, on_status):
        self.on_status = on_status
        self.music_vol = 0.8
        self.monitor_vol = 0.6
        self.mic_vol = 1.0
        self.mic_enabled = True
        self.paused = threading.Event()
        self._stop = threading.Event()
        self._decoder: threading.Thread | None = None
        self._proc: subprocess.Popen | None = None
        self._streams: list[sd._StreamBase] = []
        self.cable_buf = FrameBuffer(RATE // 4)    # 250 ms
        self.monitor_buf = FrameBuffer(RATE // 4)
        self.mic_buf = FrameBuffer(RATE // 10)     # 100 ms, keep latency low
        self.playing = False

    # ---- device streams ------------------------------------------------- #
    def open_devices(self, cable: int, monitor: int | None, mic: int | None):
        self.close_devices()

        def cable_cb(outdata, frames, _t, _status):
            if self.paused.is_set():
                music = np.zeros((frames, CHANNELS), dtype=np.float32)
            else:
                music = self.cable_buf.read(frames) * self.music_vol
            if self.mic_enabled and mic is not None:
                music += self.mic_buf.read(frames) * self.mic_vol
            np.clip(music, -1.0, 1.0, out=music)
            outdata[:] = music[:, :outdata.shape[1]]

        def monitor_cb(outdata, frames, _t, _status):
            if self.paused.is_set():
                outdata.fill(0)
                return
            data = self.monitor_buf.read(frames) * self.monitor_vol
            outdata[:] = data[:, :outdata.shape[1]]

        def mic_cb(indata, _frames, _t, _status):
            self.mic_buf.write(to_stereo(indata), block=False)

        try:
            out_ch = min(CHANNELS, sd.query_devices(cable)["max_output_channels"])
            s = sd.OutputStream(device=cable, samplerate=RATE, channels=out_ch,
                                dtype="float32", callback=cable_cb, latency="low")
            s.start()
            self._streams.append(s)
            if monitor is not None:
                ch = min(CHANNELS, sd.query_devices(monitor)["max_output_channels"])
                s = sd.OutputStream(device=monitor, samplerate=RATE, channels=ch,
                                    dtype="float32", callback=monitor_cb)
                s.start()
                self._streams.append(s)
            if mic is not None:
                ch = min(CHANNELS, sd.query_devices(mic)["max_input_channels"])
                s = sd.InputStream(device=mic, samplerate=RATE, channels=ch,
                                   dtype="float32", callback=mic_cb, latency="low")
                s.start()
                self._streams.append(s)
        except Exception:
            self.close_devices()
            raise

    def close_devices(self):
        for s in self._streams:
            try:
                s.stop()
                s.close()
            except Exception:
                pass
        self._streams.clear()

    # ---- playback --------------------------------------------------------- #
    def play(self, query: str):
        self.stop()
        self._stop = threading.Event()
        self.paused.clear()
        self._decoder = threading.Thread(target=self._decode, args=(query, self._stop), daemon=True)
        self._decoder.start()

    def _decode(self, query: str, stop: threading.Event):
        self.playing = True
        try:
            self.on_status("Looking up audio...")
            url, title = resolve_stream(query)
            if stop.is_set():
                return
            cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
            if url.startswith(("http://", "https://")):
                cmd += ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5"]
            cmd += ["-i", url, "-vn", "-f", "f32le", "-ac", str(CHANNELS), "-ar", str(RATE), "-"]
            flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            self._proc = proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                                 stderr=subprocess.PIPE, creationflags=flags)
            err_lines: list[bytes] = []
            threading.Thread(target=lambda: err_lines.extend(proc.stderr), daemon=True).start()
            self.on_status(f"Playing: {title}")
            bytes_per_block = BLOCK * CHANNELS * 4
            decoded = 0
            while not stop.is_set():
                if self.paused.is_set():
                    time.sleep(0.05)
                    continue
                raw = self._proc.stdout.read(bytes_per_block)
                if not raw:
                    break
                usable = len(raw) - len(raw) % (CHANNELS * 4)
                frames = np.frombuffer(raw[:usable], dtype=np.float32).reshape(-1, CHANNELS)
                decoded += len(frames)
                self.monitor_buf.write(frames, block=False)
                self.cable_buf.write(frames, block=True, stop=stop)  # paces to real time
            if not stop.is_set() and decoded == 0:
                proc.wait(timeout=5)
                msg = b"".join(err_lines).decode(errors="replace").strip().splitlines()
                raise RuntimeError(f"ffmpeg could not play this ({msg[-1] if msg else 'no audio'})")
            if not stop.is_set():
                while len(self.cable_buf) and not stop.is_set():  # let the tail play out
                    time.sleep(0.05)
                self.on_status(f"Finished: {title}")
        except Exception as e:  # surface any failure to the UI
            self.on_status(f"Error: {e}")
        finally:
            self.playing = False
            self._kill_proc()

    def toggle_pause(self) -> bool:
        if self.paused.is_set():
            self.paused.clear()
        else:
            self.paused.set()
        return self.paused.is_set()

    def stop(self):
        self._stop.set()
        self._kill_proc()
        if self._decoder and self._decoder.is_alive():
            self._decoder.join(timeout=2)
        self.cable_buf.clear()
        self.monitor_buf.clear()
        self.paused.clear()

    def _kill_proc(self):
        p, self._proc = self._proc, None
        if p and p.poll() is None:
            p.kill()
            try:
                p.wait(timeout=2)
            except Exception:
                pass


# --------------------------------------------------------------------------- #
# Device helpers
# --------------------------------------------------------------------------- #
CABLE_HINTS = ("cable input", "blackhole", "yt-mic", "virtual")


def list_devices(kind: str) -> list[tuple[int, str]]:
    key = "max_output_channels" if kind == "output" else "max_input_channels"
    apis = sd.query_hostapis()
    out = []
    for i, d in enumerate(sd.query_devices()):
        if d[key] > 0:
            out.append((i, f"{d['name']}  [{apis[d['hostapi']]['name']}]"))
    return out


def guess_cable(devices: list[tuple[int, str]]) -> int | None:
    # Prefer MME on Windows: it resamples for you and is the least picky.
    ranked = sorted(devices, key=lambda d: (0 if "MME" in d[1] else 1))
    for idx, label in ranked:
        if any(h in label.lower() for h in CABLE_HINTS):
            return idx
    return None


# --------------------------------------------------------------------------- #
# GUI
# --------------------------------------------------------------------------- #
def run_gui():
    import tkinter as tk
    from tkinter import messagebox, ttk

    root = tk.Tk()
    root.title("YT Mic")
    root.geometry("560x430")
    root.minsize(480, 400)

    status_q: queue.Queue[str] = queue.Queue()
    player = Player(on_status=status_q.put)

    outputs = list_devices("output")
    inputs = list_devices("input")
    none_label = "(none)"

    frm = ttk.Frame(root, padding=14)
    frm.pack(fill="both", expand=True)
    frm.columnconfigure(1, weight=1)

    ttk.Label(frm, text="YouTube link or search").grid(row=0, column=0, sticky="w")
    url_var = tk.StringVar()
    url_entry = ttk.Entry(frm, textvariable=url_var)
    url_entry.grid(row=0, column=1, columnspan=2, sticky="ew", pady=4)
    url_entry.focus()

    def combo(row, label, devices, default_idx, allow_none):
        ttk.Label(frm, text=label).grid(row=row, column=0, sticky="w")
        labels = ([none_label] if allow_none else []) + [l for _, l in devices]
        var = tk.StringVar()
        cb = ttk.Combobox(frm, textvariable=var, values=labels, state="readonly")
        cb.grid(row=row, column=1, columnspan=2, sticky="ew", pady=4)
        chosen = next((l for i, l in devices if i == default_idx), None)
        var.set(chosen or (none_label if allow_none else (labels[0] if labels else "")))
        return var

    def idx_of(var, devices):
        return next((i for i, l in devices if l == var.get()), None)

    try:
        default_out, default_in = sd.default.device
    except Exception:
        default_out = default_in = None

    cable_var = combo(1, "Send to (virtual cable)", outputs, guess_cable(outputs), False)
    monitor_var = combo(2, "Also hear it on", outputs, default_out, True)
    mic_var = combo(3, "Mix in my real mic", inputs, default_in, True)

    def slider(row, label, initial, setter):
        ttk.Label(frm, text=label).grid(row=row, column=0, sticky="w")
        v = tk.DoubleVar(value=initial * 100)
        s = ttk.Scale(frm, from_=0, to=150, variable=v,
                      command=lambda _=None: setter(v.get() / 100))
        s.grid(row=row, column=1, sticky="ew", pady=4)
        pct = ttk.Label(frm, width=5)
        pct.grid(row=row, column=2, sticky="e")
        v.trace_add("write", lambda *_: pct.config(text=f"{int(v.get())}%"))
        pct.config(text=f"{int(v.get())}%")

    slider(4, "Music volume (others)", player.music_vol, lambda x: setattr(player, "music_vol", x))
    slider(5, "Music volume (you)", player.monitor_vol, lambda x: setattr(player, "monitor_vol", x))
    slider(6, "Mic volume", player.mic_vol, lambda x: setattr(player, "mic_vol", x))

    mic_on = tk.BooleanVar(value=True)
    ttk.Checkbutton(frm, text="Mic pass-through on", variable=mic_on,
                    command=lambda: setattr(player, "mic_enabled", mic_on.get())
                    ).grid(row=7, column=1, sticky="w", pady=4)

    btns = ttk.Frame(frm)
    btns.grid(row=8, column=0, columnspan=3, pady=(10, 6))
    current = {"devices": None}

    def ensure_devices():
        sel = (idx_of(cable_var, outputs), idx_of(monitor_var, outputs), idx_of(mic_var, inputs))
        if sel[0] is None:
            raise RuntimeError("Pick the virtual cable to send audio to.")
        if sel != current["devices"]:
            player.open_devices(*sel)
            current["devices"] = sel

    def on_play(_=None):
        q = url_var.get().strip()
        if not q:
            return
        try:
            ensure_devices()
        except Exception as e:
            messagebox.showerror("Audio device error", str(e))
            return
        pause_btn.config(text="Pause")
        player.play(q)

    def on_pause():
        pause_btn.config(text="Resume" if player.toggle_pause() else "Pause")

    def on_stop():
        player.stop()
        pause_btn.config(text="Pause")
        status_var.set("Stopped")

    def on_devices_changed(*_):
        current["devices"] = None
        if player._streams:
            try:
                ensure_devices()
            except Exception as e:
                messagebox.showerror("Audio device error", str(e))

    for var in (cable_var, monitor_var, mic_var):
        var.trace_add("write", on_devices_changed)

    ttk.Button(btns, text="Play", command=on_play).pack(side="left", padx=4)
    pause_btn = ttk.Button(btns, text="Pause", command=on_pause)
    pause_btn.pack(side="left", padx=4)
    ttk.Button(btns, text="Stop", command=on_stop).pack(side="left", padx=4)
    url_entry.bind("<Return>", on_play)

    status_var = tk.StringVar(value="Ready")
    ttk.Label(frm, textvariable=status_var, wraplength=500, foreground="#555"
              ).grid(row=9, column=0, columnspan=3, sticky="w", pady=(8, 0))
    ttk.Label(frm, foreground="#888", wraplength=500,
              text="In your game, set the microphone to the cable's recording side "
                   "(for VB-CABLE: \"CABLE Output\").").grid(row=10, column=0, columnspan=3,
                                                            sticky="w", pady=(6, 0))

    def poll_status():
        try:
            while True:
                status_var.set(status_q.get_nowait())
        except queue.Empty:
            pass
        root.after(150, poll_status)

    poll_status()

    if guess_cable(outputs) is None:
        status_var.set("No virtual cable found. Install VB-CABLE (see README), then restart.")

    def on_close():
        player.stop()
        player.close_devices()
        root.destroy()

    root.protocol("WM_DELETE_WINDOW", on_close)
    root.mainloop()


def main():
    ap = argparse.ArgumentParser(description="Play YouTube audio through a virtual mic.")
    ap.add_argument("--list", action="store_true", help="list audio devices and exit")
    ap.add_argument("--browser", metavar="NAME",
                    help="use this browser's YouTube login (chrome, firefox, edge...) "
                         "if YouTube asks you to sign in")
    args = ap.parse_args()
    global COOKIE_BROWSER
    COOKIE_BROWSER = args.browser
    if args.list:
        print(sd.query_devices())
        return
    if shutil.which("ffmpeg") is None:
        print("ffmpeg was not found on PATH. Install it first (see README).", file=sys.stderr)
        try:
            import tkinter.messagebox as mb
            mb.showerror("YT Mic", "ffmpeg was not found on PATH.\n\nWindows: winget install ffmpeg\n"
                                   "Then restart this app.")
        except Exception:
            pass
        sys.exit(1)
    run_gui()


if __name__ == "__main__":
    main()
