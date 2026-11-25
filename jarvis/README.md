# Jarvis

A voice-first assistant for turning a rough idea into something concrete. Talk or type, and Jarvis asks one useful question at a time, offers a few replies based on what you said, then sums up your goal in your words and suggests a next step.

It works out of the box with a built-in **simulated** demo model (no account, clearly labelled), and connects to as many real providers as you like.

## Run it

Needs Node 20 or newer. No dependencies to install.

```bash
cd jarvis
npm start
```

Open http://127.0.0.1:4173 in Chrome, Edge or Safari (Firefox has no speech recognition, so typing works but talking does not).

`PORT=8080 npm start` changes the port. `JARVIS_LOG_REQUESTS=1 npm start` prints every outgoing model request to the terminal with keys hidden.

## What's in it

- **The orb.** Breathes slowly when idle, ripples with your microphone volume while listening, rotates while waiting for a reply, and moves while speaking until playback stops. Each state has a plain-language status line. It follows your system's reduced-motion setting, and Settings › General can switch animations on or off.
- **Voice.** Live transcript while you speak, spoken replies, one tap (orb, Interrupt, or Esc) to cut in, optional hands-free mode that listens again after Jarvis finishes, and End conversation. The mic only opens when you tap Talk and is off while Jarvis speaks, so it never transcribes itself. Pick the voice, speed and language under Settings › Voice.
- **Connections.** OpenAI, Anthropic, Google Gemini, Hugging Face Inference Providers, OpenRouter, Ollama, and any OpenAI-compatible server (LM Studio, vLLM, llama.cpp). Discover models or type an ID. Several connections can be active at once.
- **Auto.** Picks a model per message from the kind of message (coding, planning, writing, quick reply) and your priority (balanced, quality, speed, prefer local). Every reply says which model answered and why. Switch models from the header at any time; the conversation carries over.
- **Model settings.** Shows the controls the selected provider and model support, each marked Supported, May not work, or Not supported: temperature, top-p, top-k, output limit, stop sequences, seed, frequency and presence penalties, reasoning effort or budget, response format and streaming, plus provider-specific options and an Advanced JSON box. Every control starts at **Provider default** and is left out of the request until you change it. Settings are saved per connection and model, with named presets, restore defaults, inline validation of ranges and bad combinations, and a live preview of the next request.
- **Errors you can fix.** When a provider rejects a setting, Jarvis names it, offers a "Fix …" button that jumps to that control, and keeps your message for Retry or Edit.
- **Memory with consent.** When you state a lasting preference, Jarvis asks before remembering it. Settings › Memory lets you edit or delete anything.

## Where things live

Keys, settings, memories and the current conversation are stored in your browser's local storage. Model requests go from the page to the small local server (`server.js`, bound to 127.0.0.1), which forwards them to the provider. This avoids browser CORS blocks; nothing is sent anywhere else.

For Ollama, run `ollama serve` and pull a model first (`ollama pull llama3.2`). The default base URL is `http://localhost:11434`.

## Model support notes

Support levels come from each provider's documented API and are model-aware where it matters:

- **Anthropic:** current Claude models (Opus 5.5, Sonnet 5.5, Fable, Opus 4.7 and later) reject temperature, top-p and top-k and think adaptively, so those controls are disabled and reasoning effort maps to `output_config.effort`. Older Claude models keep sampling controls and a thinking budget. Anthropic requires an output limit, so Jarvis sends 4096 while that control is on Provider default, and the panel says so.
- **OpenAI:** o-series and GPT-5 reasoning models reject sampling settings and take reasoning effort; other models take the full sampling set.
- **OpenRouter:** discovery reads each model's `supported_parameters`, so support is exact rather than guessed.
- **Gemini:** discovery reads each model's output limit, maximum temperature and whether it thinks.
- Anything Jarvis can't be sure of is marked **May not work** rather than hidden.

## Tests

```bash
npm test          # unit tests: request building, validation, error attribution, Auto, reply parsing
npm run test:e2e  # browser tests (needs Playwright with Chromium available to require('playwright'))
```

The browser suite runs the real server and page in Chromium against a mock provider that records the exact requests it receives. It covers a first conversation, voice with interruption and hands-free, a blocked microphone, a mid-chat model switch, two models with different settings, a rejected setting, pre-send validation, presets and Advanced JSON, reduced motion, phone layout and keyboard access, streaming and Stop. `SHOT_DIR=/some/folder npm run test:e2e` saves screenshots.
