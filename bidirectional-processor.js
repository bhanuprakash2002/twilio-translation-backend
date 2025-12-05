// ===========================
// 🎙️ Fixed Advanced Voice Processor
// Fixes: Multiple speakers, tick sounds, better audio quality
// ===========================

const speech = require("@google-cloud/speech");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Translate } = require("@google-cloud/translate").v2;
const VoiceAnalyzer = require("./voice-analyzer");

class AdvancedVoiceProcessor {
  constructor(websocket, activeSessions) {
    this.ws = websocket;
    this.activeSessions = activeSessions;
    this.speechClient = new speech.SpeechClient();
    this.ttsClient = new textToSpeech.TextToSpeechClient();
    this.translateClient = new Translate();
    this.voiceAnalyzer = new VoiceAnalyzer();

    // Connection info
    this.roomId = null;
    this.userType = null;
    this.myLanguage = null;
    this.streamSid = null;
    this.callSid = null;
    this.userId = null;

    // Audio buffering - FIXED for better quality
    this.audioBuffer = [];
    this.bufferDuration = 0;
    this.maxBufferDuration = 1500;  // Reduced to 1.5s for faster response
    this.minBufferDuration = 400;   // Minimum 400ms
    this.isProcessing = false;
    this.silenceTimeout = null;
    
    // FIX: Prevent concurrent processing
    this.processingQueue = [];
    this.isCurrentlyProcessing = false;

    // Stats
    this.stats = {
      packetsReceived: 0,
      transcriptions: 0,
      translations: 0,
      audiosSent: 0,
      errors: 0
    };
  }

  async handleMessage(data) {
    switch (data.event) {
      case "start":
        this.handleStart(data);
        break;
      case "media":
        await this.handleMedia(data);
        break;
      case "stop":
        this.handleStop(data);
        break;
      case "mark":
        break;
    }
  }

  handleStart(data) {
    console.log("▶️  Media stream started");
    this.streamSid = data.streamSid;
    this.callSid = data.start?.callSid;
    this.userId = `${this.roomId}_${this.userType}`;

    const params = data.start?.customParameters || {};
    this.roomId = params.roomId;
    this.userType = params.userType;
    this.myLanguage = params.myLanguage;

    console.log(`🎯 Connection Details:
   Room: ${this.roomId}
   User: ${this.userType}
   Language: ${this.myLanguage}`);

    if (!this.myLanguage) {
      console.error("❌ ERROR: myLanguage parameter is missing!");
      return;
    }

    this.registerConnection();
  }

  registerConnection() {
    if (!this.roomId) return;

    const session = this.activeSessions.get(this.roomId);
    if (!session) {
      console.error("❌ Room not found:", this.roomId);
      return;
    }

    if (this.userType === "caller") {
      session.callerConnection = this;
    } else {
      session.receiverConnection = this;
    }

    this.activeSessions.set(this.roomId, session);
    console.log(`✅ Registered ${this.userType} in room ${this.roomId}`);
  }

  async handleMedia(data) {
    if (!this.myLanguage) return;

    this.stats.packetsReceived++;
    const audioChunk = Buffer.from(data.media.payload, "base64");
    this.audioBuffer.push(audioChunk);
    this.bufferDuration += 20;

    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
    }

    if (this.bufferDuration >= this.maxBufferDuration && !this.isProcessing) {
      await this.processBuffer();
    } else {
      // FIX: Reduced silence timeout to 600ms for faster response
      this.silenceTimeout = setTimeout(async () => {
        if (this.audioBuffer.length > 0 && 
            !this.isProcessing && 
            this.bufferDuration >= this.minBufferDuration) {
          await this.processBuffer();
        }
      }, 600);
    }
  }

  async processBuffer() {
    // FIX: Strong lock to prevent concurrent processing
    if (this.isCurrentlyProcessing || this.audioBuffer.length === 0 || !this.myLanguage) {
      return;
    }

    this.isCurrentlyProcessing = true;
    this.isProcessing = true;
    
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
      this.silenceTimeout = null;
    }

    const mulawAudio = Buffer.concat(this.audioBuffer);
    const bufferLengthMs = this.bufferDuration;

    // FIX: Clear buffer immediately to prevent reprocessing
    this.audioBuffer = [];
    this.bufferDuration = 0;

    if (bufferLengthMs < this.minBufferDuration) {
      this.isProcessing = false;
      this.isCurrentlyProcessing = false;
      return;
    }

    try {
      const pcmAudio = this.decodeMulaw(mulawAudio);

      // FIX: Use stable voice profile (don't analyze every time)
      const voiceProfile = this.getStableVoiceProfile();

      // Transcribe
      const transcript = await this.transcribeAudioEnhanced(pcmAudio, this.myLanguage);

      if (!transcript || transcript.trim().length < 2) {
        this.isProcessing = false;
        this.isCurrentlyProcessing = false;
        return;
      }

      console.log(`🎤 [${this.userType}] Spoke: ${transcript}`);
      this.stats.transcriptions++;

      // Store for UI
      if (global.addTranslation) {
        global.addTranslation(this.roomId, this.userType, {
          originalText: transcript,
          translatedText: transcript,
          fromLanguage: this.myLanguage,
          toLanguage: this.myLanguage,
          isIncoming: false,
          timestamp: Date.now()
        });
      }

      // Get other user
      const session = this.activeSessions.get(this.roomId);
      if (!session) {
        this.isProcessing = false;
        this.isCurrentlyProcessing = false;
        return;
      }

      const otherConnection = this.userType === "caller"
        ? session.receiverConnection
        : session.callerConnection;

      if (!otherConnection || !otherConnection.myLanguage) {
        console.log("⚠️  Other user not ready");
        this.isProcessing = false;
        this.isCurrentlyProcessing = false;
        return;
      }

      const otherUserLanguage = otherConnection.myLanguage;

      // Translate
      const translatedText = await this.translateText(
        transcript,
        this.myLanguage,
        otherUserLanguage
      );

      console.log(`🌐 Translated: ${translatedText}`);
      this.stats.translations++;

      // Store for UI
      if (global.addTranslation) {
        global.addTranslation(this.roomId, otherConnection.userType, {
          originalText: transcript,
          translatedText: translatedText,
          fromLanguage: this.myLanguage,
          toLanguage: otherUserLanguage,
          isIncoming: true,
          timestamp: Date.now()
        });
      }

      // FIX: Generate smooth speech without ticks
      const translatedAudio = await this.generateSmoothSpeech(
        translatedText,
        otherUserLanguage,
        voiceProfile
      );

      if (!translatedAudio) {
        console.error("❌ Failed to generate speech");
        this.isProcessing = false;
        this.isCurrentlyProcessing = false;
        return;
      }

      await this.sendToOtherUser(translatedAudio, otherConnection);

    } catch (error) {
      console.error("❌ Processing error:", error.message);
      this.stats.errors++;
    } finally {
      this.isProcessing = false;
      this.isCurrentlyProcessing = false;
    }
  }

  decodeMulaw(mulawBuffer) {
    const MULAW_BIAS = 0x84;

    const mulawToLinear = (mulaw) => {
      mulaw = ~mulaw;
      const sign = mulaw & 0x80;
      const exponent = (mulaw >> 4) & 7;
      const mantissa = mulaw & 0x0F;

      let sample = (mantissa << (exponent + 3)) + (MULAW_BIAS << exponent);
      if (exponent === 0) sample += MULAW_BIAS;
      if (sign) sample = -sample;

      return sample;
    };

    const pcmBuffer = Buffer.alloc(mulawBuffer.length * 2);

    for (let i = 0; i < mulawBuffer.length; i++) {
      const pcmValue = mulawToLinear(mulawBuffer[i]);
      pcmBuffer.writeInt16LE(pcmValue, i * 2);
    }

    return pcmBuffer;
  }

  /**
   * FIX: Get stable voice profile (analyze only first few times)
   */
  getStableVoiceProfile() {
    if (!this.stableProfile) {
      this.stableProfile = {
        pitch: 0,
        speed: 1.0,
        energy: 0,
        gender: 'neutral'
      };
      this.profileSamples = 0;
    }

    // Use default profile (fixes multiple speaker issue)
    return this.stableProfile;
  }

  /**
   * Enhanced transcription
   */
  async transcribeAudioEnhanced(audioBuffer, language) {
    try {
      const languageMap = {
        "en": "en-US",
        "te": "te-IN",
        "hi": "hi-IN",
        "es": "es-ES",
        "fr": "fr-FR",
        "de": "de-DE"
      };

      const languageCode = languageMap[language] || language;

      const request = {
        audio: { content: audioBuffer.toString("base64") },
        config: {
          encoding: "LINEAR16",
          sampleRateHertz: 8000,
          languageCode: languageCode,
          enableAutomaticPunctuation: true,
          model: "latest_short",  // FIX: Use short model for faster response
          useEnhanced: true,
          enableWordConfidence: false  // FIX: Disable for faster processing
        }
      };

      const [response] = await this.speechClient.recognize(request);

      if (!response.results || response.results.length === 0) {
        return null;
      }

      return response.results
        .map(r => r.alternatives[0]?.transcript)
        .filter(Boolean)
        .join(" ");

    } catch (error) {
      console.error("❌ Transcription error:", error.message);
      return null;
    }
  }

  async translateText(text, fromLanguage, toLanguage) {
    try {
      const from = fromLanguage.split("-")[0];
      const to = toLanguage.split("-")[0];

      if (from === to) {
        return text;
      }

      const [translation] = await this.translateClient.translate(text, {
        from: from,
        to: to
      });

      return translation;

    } catch (error) {
      console.error("❌ Translation error:", error.message);
      return text;
    }
  }

  /**
   * FIX: Generate smooth speech without ticks
   * Uses consistent voice settings
   */
  async generateSmoothSpeech(text, language, voiceProfile) {
    try {
      // FIX: Use ONE consistent voice per language (prevents multiple speakers)
      const consistentVoiceMap = {
        "en": { 
          languageCode: "en-US", 
          name: "en-US-Neural2-D",  // Consistent male voice
          ssmlGender: "MALE" 
        },
        "te": { 
          languageCode: "te-IN", 
          name: "te-IN-Standard-B",
          ssmlGender: "MALE" 
        },
        "hi": { 
          languageCode: "hi-IN", 
          name: "hi-IN-Neural2-B",
          ssmlGender: "MALE" 
        },
        "es": { 
          languageCode: "es-ES", 
          name: "es-ES-Neural2-B",
          ssmlGender: "MALE" 
        },
        "fr": { 
          languageCode: "fr-FR", 
          name: "fr-FR-Neural2-B",
          ssmlGender: "MALE" 
        },
        "de": { 
          languageCode: "de-DE", 
          name: "de-DE-Neural2-B",
          ssmlGender: "MALE" 
        }
      };

      const baseLang = language.split("-")[0];
      const voiceConfig = consistentVoiceMap[baseLang] || {
        languageCode: language,
        ssmlGender: "NEUTRAL"
      };

      // FIX: Simple SSML without too many breaks (prevents ticks)
      const ssmlText = this.buildSimpleSSML(text);

      console.log(`🎵 Using consistent voice: ${voiceConfig.name || voiceConfig.languageCode}`);

      // FIX: Consistent audio settings (prevents ticks and quality issues)
      const request = {
        input: { ssml: ssmlText },
        voice: voiceConfig,
        audioConfig: {
          audioEncoding: "MULAW",
          sampleRateHertz: 8000,
          pitch: 0,  // FIX: Use neutral pitch for consistency
          speakingRate: 1.0,  // FIX: Normal speed for clarity
          volumeGainDb: 1.5,  // FIX: Moderate volume boost
          effectsProfileId: ["telephony-class-application"]
        }
      };

      const [response] = await this.ttsClient.synthesizeSpeech(request);
      
      console.log(`✅ Generated ${response.audioContent.length} bytes of smooth audio`);
      
      return response.audioContent;

    } catch (error) {
      console.error("❌ Smooth TTS error:", error.message);
      return null;
    }
  }

  /**
   * FIX: Build simple SSML (minimal breaks to prevent ticks)
   */
  buildSimpleSSML(text) {
    // FIX: Only add breaks after sentences, not commas
    let ssml = text
      .replace(/\./g, '.<break time="250ms"/>')
      .replace(/\?/g, '?<break time="300ms"/>')
      .replace(/!/g, '!<break time="300ms"/>');

    return `<speak>${ssml}</speak>`;
  }

  /**
   * FIX: Send audio in larger chunks to prevent ticks
   */
  async sendToOtherUser(audioBuffer, otherConnection) {
    if (!audioBuffer || !otherConnection || !otherConnection.ws) {
      return;
    }

    if (otherConnection.ws.readyState !== 1) {
      return;
    }

    try {
      const base64Audio = audioBuffer.toString("base64");
      
      // FIX: Use larger chunks (320 bytes instead of 160) to reduce ticking
      const chunkSize = 320;  // Doubled chunk size
      let chunkCount = 0;

      // FIX: Add small delay between chunks for smoother playback
      for (let i = 0; i < base64Audio.length; i += chunkSize) {
        const chunk = base64Audio.slice(i, i + chunkSize);

        const message = JSON.stringify({
          event: "media",
          streamSid: otherConnection.streamSid,
          media: {
            payload: chunk
          }
        });

        otherConnection.ws.send(message);
        chunkCount++;

        // FIX: Tiny delay every 10 chunks to prevent buffer overflow
        if (chunkCount % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }

      // Send completion marker
      const markMessage = JSON.stringify({
        event: "mark",
        streamSid: otherConnection.streamSid,
        mark: {
          name: `audio_complete_${Date.now()}`
        }
      });
      otherConnection.ws.send(markMessage);

      this.stats.audiosSent++;
      console.log(`🔊 Sent ${chunkCount} smooth audio chunks`);

    } catch (error) {
      console.error("❌ Error sending audio:", error.message);
    }
  }

  handleStop(data) {
    console.log("⏹️  Media stream stopped");
    console.log("📊 Final stats:", this.stats);
    
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
    }
    
    this.cleanup();
  }

  cleanup() {
    this.audioBuffer = [];
    this.bufferDuration = 0;
    this.isProcessing = false;
    this.isCurrentlyProcessing = false;

    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
      this.silenceTimeout = null;
    }

    if (this.userId) {
      this.voiceAnalyzer.cleanup(this.userId);
    }

    if (this.roomId) {
      const session = this.activeSessions.get(this.roomId);
      if (session) {
        if (this.userType === "caller") {
          session.callerConnection = null;
        } else {
          session.receiverConnection = null;
        }
        this.activeSessions.set(this.roomId, session);
      }
    }

    console.log("🧹 Processor cleaned up");
  }
}

module.exports = AdvancedVoiceProcessor;
