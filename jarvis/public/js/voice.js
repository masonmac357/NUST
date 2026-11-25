// Browser voice: speech recognition for listening, speech synthesis for
// replies, and a microphone level meter for the orb.
//
// Half duplex on purpose: recognition is stopped before Jarvis speaks and
// only restarted after playback ends, and any result that arrives while
// Jarvis is speaking is dropped. That is what keeps Jarvis from transcribing
// its own voice.

export class Voice {
  constructor(handlers = {}) {
    this.h = handlers;
    const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    this.SR = SR || null;
    this.synth = globalThis.speechSynthesis || null;
    this.supported = { recognition: !!SR, synthesis: !!this.synth, mic: !!navigator.mediaDevices?.getUserMedia };
    this.settings = { voiceURI: '', rate: 1, lang: '' };
    this.listening = false;
    this.speaking = false;
    this.rec = null;
    this.stream = null;
    this.audio = null;
    this.raf = 0;
    this.finalText = '';
    this.speakToken = 0;
    if (this.synth) {
      const update = () => this.h.onVoices?.(this.voices());
      this.synth.addEventListener?.('voiceschanged', update);
      setTimeout(update, 0);
    }
  }

  voices() {
    try { return this.synth ? this.synth.getVoices() : []; } catch { return []; }
  }

  lang() {
    return this.settings.lang || navigator.language || 'en-US';
  }

  async startListening() {
    if (this.listening) return true;
    if (this.speaking) this.cancelSpeech();
    if (!this.supported.recognition) {
      this.h.onError?.({ code: 'no-recognition', message: 'This browser can’t turn speech into text. Try Chrome, Edge or Safari, or type your message instead.' });
      return false;
    }
    // Ask for the microphone ourselves first: it gives a clear permission
    // error and feeds the orb's level meter.
    if (this.supported.mic && !this.stream) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        this.startMeter();
      } catch (e) {
        this.stopMeter();
        const blocked = e && (e.name === 'NotAllowedError' || e.name === 'SecurityError' || e.name === 'PermissionDeniedError');
        const missing = e && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError');
        this.h.onError?.({
          code: blocked ? 'mic-blocked' : missing ? 'mic-missing' : 'mic-error',
          message: blocked
            ? 'Microphone access is blocked. Allow it from the lock or camera icon in your address bar, then try again. You can keep typing meanwhile.'
            : missing ? 'No microphone was found. Plug one in, or type your message instead.'
              : `The microphone could not start (${e?.message || e}). You can type instead.`,
        });
        return false;
      }
    }
    this.finalText = '';
    const rec = new this.SR();
    rec.lang = this.lang();
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => {
      if (this.speaking) return; // never hear ourselves
      let interim = '';
      let final = '';
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.finalText = final;
      this.h.onInterim?.((final + ' ' + interim).trim());
    };
    rec.onerror = (ev) => {
      if (ev.error === 'no-speech' || ev.error === 'aborted') return;
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        this.h.onError?.({ code: 'mic-blocked', message: 'Speech recognition was blocked by the browser. Allow microphone access for this page, or type instead.' });
      } else if (ev.error === 'network') {
        this.h.onError?.({ code: 'network', message: 'Speech recognition needs a network connection in this browser. You can type instead.' });
      } else {
        this.h.onError?.({ code: ev.error, message: `Speech recognition stopped (${ev.error}).` });
      }
    };
    rec.onend = () => {
      const wasListening = this.listening;
      this.listening = false;
      this.rec = null;
      if (!wasListening) return;
      const text = this.finalText.trim();
      this.releaseMic();
      this.h.onListenEnd?.(text);
    };
    this.rec = rec;
    this.listening = true;
    try { rec.start(); } catch (e) {
      this.listening = false;
      this.h.onError?.({ code: 'start-failed', message: `Listening could not start (${e.message}).` });
      return false;
    }
    this.h.onListenStart?.();
    return true;
  }

  // Stop and deliver what was heard so far.
  stopListening() {
    if (this.rec) { try { this.rec.stop(); } catch { /* ignore */ } }
  }

  // Stop and throw away what was heard.
  abortListening() {
    if (this.rec) {
      this.listening = false;
      try { this.rec.abort(); } catch { /* ignore */ }
      this.rec = null;
    }
    this.releaseMic();
  }

  startMeter() {
    try {
      const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!Ctx || !this.stream) return;
      this.audio = new Ctx();
      const src = this.audio.createMediaStreamSource(this.stream);
      const an = this.audio.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const data = new Uint8Array(an.fftSize);
      const tick = () => {
        an.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
        const rms = Math.sqrt(sum / data.length);
        this.h.onLevel?.(Math.min(1, rms * 4));
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch { /* meter is optional */ }
  }

  stopMeter() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    try { this.audio?.close(); } catch { /* ignore */ }
    this.audio = null;
    this.h.onLevel?.(0);
  }

  releaseMic() {
    this.stopMeter();
    if (this.stream) { for (const t of this.stream.getTracks()) t.stop(); }
    this.stream = null;
  }

  // Speak text in sentence-sized chunks (long single utterances are cut off
  // in some browsers). Resolves true when finished, false when interrupted.
  speak(text) {
    if (!this.synth || !text) return Promise.resolve(false);
    this.abortListening();
    this.synth.cancel();
    const token = ++this.speakToken;
    const chunks = (text.match(/[^.!?\n]+[.!?]*\s*/g) || [text]).map((s) => s.trim()).filter(Boolean);
    const voice = this.voices().find((v) => v.voiceURI === this.settings.voiceURI);
    this.speaking = true;
    this.h.onSpeakStart?.();
    return new Promise((resolve) => {
      let i = 0;
      const finish = (completed) => {
        if (token !== this.speakToken) return resolve(false);
        this.speaking = false;
        this.h.onSpeakEnd?.(completed);
        resolve(completed);
      };
      const next = () => {
        if (token !== this.speakToken) return resolve(false);
        if (i >= chunks.length) return finish(true);
        const u = new SpeechSynthesisUtterance(chunks[i++]);
        u.lang = voice?.lang || this.lang();
        if (voice) u.voice = voice;
        u.rate = this.settings.rate || 1;
        u.onboundary = () => this.h.onWord?.();
        u.onend = next;
        u.onerror = (e) => {
          if (e.error === 'interrupted' || e.error === 'canceled') return;
          next();
        };
        this.synth.speak(u);
      };
      next();
    });
  }

  cancelSpeech() {
    if (!this.speaking && !this.synth?.speaking) return false;
    this.speakToken++;
    this.speaking = false;
    try { this.synth.cancel(); } catch { /* ignore */ }
    this.h.onSpeakEnd?.(false);
    return true;
  }

  shutdown() {
    this.cancelSpeech();
    this.abortListening();
  }
}
