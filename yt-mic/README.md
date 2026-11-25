# YT Mic

Play the audio from any YouTube video through your microphone, so people in a
game's voice chat hear it. Your real mic can be mixed in, so you can talk over
it, and you can hear the music in your own headphones too.

## How it works

Windows only lets a driver create a microphone, so YT Mic uses a free virtual
audio cable. The app plays YouTube audio (plus your real mic) into the cable's
input side. The game listens to the cable's output side as if it were a mic.

```
YouTube ──► YT Mic ──► CABLE Input ══► CABLE Output ──► game mic
your mic ──┘   └──► your headphones (optional)
```

## Setup (Windows)

1. Install **VB-CABLE** (free): https://vb-audio.com/Cable/ . Unzip it, run
   `VBCABLE_Setup_x64.exe` as administrator, then reboot.
2. Install **Python 3.10+** from python.org. Tick "Add to PATH".
3. Install **ffmpeg**:
   ```bash
   winget install ffmpeg
   ```
4. Install the Python packages from this folder:
   ```bash
   pip install -r requirements.txt
   ```
5. Run it:
   ```bash
   python yt_mic.py
   ```

macOS: use [BlackHole](https://github.com/ExistentialAudio/BlackHole) as the
cable and `brew install ffmpeg`. Linux (PipeWire/Pulse): create a virtual mic with
```bash
pactl load-module module-null-sink sink_name=ytmic sink_properties=device.description=YT-Mic
```
then pick `Monitor of YT-Mic` as the mic in the game.

## Using it

1. **Send to**: pick `CABLE Input (VB-Audio Virtual Cable) [MME]`. The app picks
   it for you when it's installed.
2. **Also hear it on**: your headphones, or `(none)`.
3. **Mix in my real mic**: your actual microphone, or `(none)` for music only.
4. Paste a YouTube link (or just type a song name to search) and press **Play**.
5. In the game (or Discord), set the input/microphone device to
   **CABLE Output (VB-Audio Virtual Cable)**.

Tips:

- Turn off the game's noise suppression / "voice activity" or it may cut the
  music. Use open mic or keep push-to-talk held.
- Never set a game's or Windows' *speaker* output to CABLE Input, or game
  sounds go into your mic and loop.
- If a device gives an error, try the same device with a different tag
  (`[MME]` is the most forgiving, `[Windows WASAPI]` has lower latency).
- If a video stops working, update yt-dlp: `pip install -U yt-dlp`.
- `python yt_mic.py --list` prints every audio device.

Be considerate: some games and servers ban music in voice chat, and the
audio you play is subject to its own copyright.

If YouTube says "Sign in to confirm you're not a bot", start the app with your
browser's login (close that browser first):
```bash
python yt_mic.py --browser chrome
```
