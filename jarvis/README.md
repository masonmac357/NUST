# Jarvis

A voice-first desktop app for turning a rough idea into something concrete, powered only by Claude. Talk or type, and Jarvis asks one useful question at a time, offers a few replies based on what you said, then sums up your goal in your words and suggests a next step.

**Jarvis only talks to Claude.** The app's relay refuses every host except `api.anthropic.com`, and by default speech stays on your computer (see [Voice and privacy](#voice-and-privacy)).

## Run it on your PC

### Option 1: the ready-made app (nothing to install)

Download the file for your computer and double-click it:

| Computer | File |
|---|---|
| Windows 10/11 | `Jarvis-windows-x64.exe` |
| Mac with Apple silicon (M1 or later) | `Jarvis-macos-arm64` |
| Intel Mac | `Jarvis-macos-x64` |
| Linux | `Jarvis-linux-x64` |

Jarvis opens in its own window, using Microsoft Edge or Google Chrome in app mode (Windows already has Edge). Close the window to quit. A small console window stays open alongside it; that is the part that talks to Claude.

The first time, Jarvis asks for your Anthropic API key. Create one at [platform.claude.com](https://platform.claude.com/settings/keys).

First-launch warnings, because the app isn't code-signed:

- **Windows:** SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**.
- **macOS:** run `chmod +x Jarvis-macos-arm64` once, then right-click the file, choose **Open**, and confirm. If macOS still refuses, run `xattr -d com.apple.quarantine Jarvis-macos-arm64`.
- **Linux:** run `chmod +x Jarvis-linux-x64`, then start it.

### Option 2: from source

Needs Node 20 or newer, with no dependencies to install:

```bash
cd jarvis
npm start
```

### Build the app files yourself

Needs [Bun](https://bun.sh) (it compiles the app into a single file and can build for every platform from one machine):

```bash
cd jarvis
npm run build:desktop
```

The files land in `jarvis/dist/`. Build just one platform with `node scripts/build-desktop.mjs windows` (or `macos`, `linux`).

## What's in it

- **The orb.** It breathes slowly when idle, ripples with your microphone volume while listening, and rotates while waiting for Claude. While Jarvis speaks it moves, and it settles the moment playback stops. Each state has a plain-language status line. It follows your system's reduced-motion setting, and Settings › General turns animations on or off.
- **Voice.** You get a live transcript while you speak and spoken replies. One tap on the orb, Interrupt, or Esc cuts Jarvis off. Hands-free mode listens again after each reply, and End conversation clears the chat. The microphone only opens when you tap Talk and is off while Jarvis speaks, so it never transcribes itself. Pick the voice, speed and language in Settings › Voice.
- **Claude models.** Opus 5.5, Sonnet 5.5 and Haiku 5.5 are on by default; Jarvis asks Anthropic which other models your key can use. You can add several keys (for separate accounts or workspaces).
- **Auto.** For each message, Auto picks a Claude model from the kind of message (coding, planning, writing, quick reply) and your priority (balanced, quality, speed). Every reply says which model answered and why. Switch models from the header at any time; the conversation carries over.
- **Model settings.** Each control is marked Supported, May not work, or Not supported for the exact model: temperature, top-p, top-k, output limit, stop sequences, reasoning effort or budget, and streaming. Claude-specific options are thinking summaries, inference region and refusal fallback, and an Advanced JSON box covers anything else (such as structured output schemas). Each control starts at Claude's default and is left out of the request until you change it. Settings are saved per key and model, with named presets, restore defaults, inline checks for out-of-range values and bad combinations, and a live preview of the next request.
- **Errors you can fix.** When Claude rejects a setting, Jarvis names it, offers a "Fix …" button that jumps to that control, and keeps your message for Retry or Edit.
- **Memory with consent.** When you state a lasting preference, Jarvis asks before remembering it. Settings › Memory lets you edit or delete anything.

### Two defaults that are not Claude's own

- **Output limit.** The API requires one, so Jarvis sends 16,000 tokens (64,000 when streaming) until you set your own.
- **Refusal fallback.** On models that support it (Opus 5.5, Sonnet 5.5, Fable), Jarvis asks Anthropic to retry a declined request on another Claude model in the same call, and the reply shows when that happened. Turn it off per model under Model settings › Claude options.

### Why sampling controls are greyed out

Current Claude models (Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable, Opus 4.7 and later) reject temperature, top-p and top-k, and think adaptively, so Jarvis disables those controls and offers reasoning effort instead. Older models you add, such as Sonnet 4.5, get the full sampling set and a thinking budget.

## Voice and privacy

Browsers' built-in speech features usually send audio (for recognition) or reply text (for "online" voices) to the browser maker's servers. That would break "only talks to Claude", so by default Jarvis:

- uses **on-device speech recognition only**, where the browser offers it, and otherwise doesn't open the microphone. It explains why and offers an **Allow browser speech service** button.
- reads replies aloud with **on-device voices only**.

You can change this in Settings › Voice. Typing always works.

## Where things live

Your keys, settings, memories and current conversation stay on your computer: in the app window's private profile (`%APPDATA%\Jarvis` on Windows, `~/Library/Application Support/Jarvis` on macOS, `~/.config/jarvis` on Linux). The app listens only on `127.0.0.1:47815` and forwards requests to `api.anthropic.com`.

To route through an approved Claude gateway, start Jarvis with `JARVIS_ALLOWED_HOSTS=your.gateway.host` and set the base URL under Settings › Connections › Edit connection. `JARVIS_PORT` changes the port; changing it starts with fresh settings.

## Tests

```bash
npm test          # unit tests: request building, defaults, validation, error attribution, Auto, reply parsing
npm run test:e2e  # browser tests (needs Playwright with Chromium available to require('playwright'))
```

The browser suite runs the real app in Chromium against a mock of Anthropic's API that records the exact requests it receives. It covers:

- first-run key setup and a full conversation
- voice with interruption and hands-free, plus the voice privacy gate and a blocked microphone
- a mid-chat switch between two models with different settings
- a rejected setting, pre-send validation, refusals and fallbacks
- presets and Advanced JSON
- reduced motion, phone layout and keyboard access, streaming and Stop
- the relay refusing non-Claude hosts

`SHOT_DIR=/some/folder npm run test:e2e` saves screenshots.
