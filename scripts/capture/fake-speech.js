// A stand-in for the browser's speech recognition, for the capture tool only (a view's `script:`, scripts/capture/
// views.ts): no microphone and no recognition service. Started, it "hears" a few words that are not final yet and
// keeps listening until it is stopped, so a picture shows a chat's box while it listens (apps/web/src/voice.ts).
(() => {
  class FakeSpeechRecognition {
    constructor() {
      this.lang = "";
      this.continuous = false;
      this.interimResults = false;
      this.onresult = null;
      this.onerror = null;
      this.onend = null;
      this.timer = undefined;
    }
    start() {
      this.timer = setTimeout(() => {
        const heard = { isFinal: false, 0: { transcript: "let's look at the second step again" }, length: 1 };
        this.onresult?.({ resultIndex: 0, results: [heard] });
      }, 200);
    }
    stop() { clearTimeout(this.timer); this.onend?.(); }
    abort() { clearTimeout(this.timer); }
  }
  window.SpeechRecognition = FakeSpeechRecognition;
  window.webkitSpeechRecognition = FakeSpeechRecognition;
})();
