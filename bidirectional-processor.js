// ===========================
// 🎙️ Advanced Voice Processor - Human-like Natural Speech
// Techniques: SSML, Prosody, Emphasis, Better voices, Streaming
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

    // Audio buffering - IMPROVED for better quality
    this.audioBuffer = [];
    this.bufferDuration = 0;
    this.maxBufferDuration = 2000;  // Increased to 2 seconds for complete sentences
    this.minBufferDuration = 500;   // Minimum 500ms
    this.isProcessing = false;
    this.silenceTimeout = null;

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
      // Process after 800ms of silence (better for complete thoughts)
      this.silenceTimeout = setTimeout(async () => {
        if (this.audioBuffer.length > 0 && 
            !this.isProcessing && 
            this.bufferDuration >= this.minBufferDuration) {
          await this.processBuffer();
        }
      }, 800);
    }
  }

  async processBuffer() {
    if (this.audioBuffer.length === 0 || !this.myLanguage || this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    
    if (this.silenceTimeout) {
      clearTimeout(this.silenceTimeout);
      this.silenceTimeout = null;
    }

    const mulawAudio = Buffer.concat(this.audioBuffer);
    const bufferLengthMs = this.bufferDuration;

    this.audioBuffer = [];
    this.bufferDuration = 0;

    if (bufferLengthMs < this.minBufferDuration) {
      this.isProcessing = false;
      return;
    }

    try {
      const pcmAudio = this.decodeMulaw(mulawAudio);

      // Analyze voice
      const voiceProfile = this.voiceAnalyzer.analyzeVoice(pcmAudio, this.userId);

      // Transcribe with better model
      const transcript = await this.transcribeAudioEnhanced(pcmAudio, this.myLanguage);

      if (!transcript || transcript.trim().length < 2) {
        this.isProcessing = false;
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
        return;
      }

      const otherConnection = this.userType === "caller"
        ? session.receiverConnection
        : session.callerConnection;

      if (!otherConnection || !otherConnection.myLanguage) {
        console.log("⚠️  Other user not ready");
        this.isProcessing = false;
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

      // 🔥 Generate HUMAN-LIKE speech
      const translatedAudio = await this.generateHumanLikeSpeech(
        translatedText,
        otherUserLanguage,
        voiceProfile,
        transcript  // Pass original for context
      );

      if (!translatedAudio) {
        console.error("❌ Failed to generate speech");
        this.isProcessing = false;
        return;
      }

      await this.sendToOtherUser(translatedAudio, otherConnection);

    } catch (error) {
      console.error("❌ Processing error:", error.message);
      this.stats.errors++;
    } finally {
      this.isProcessing = false;
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
   * 🔥 Enhanced transcription with better model
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
          // 🔥 Use enhanced model for better accuracy
          model: "latest_long",
          useEnhanced: true,
          // 🔥 Enable speaker diarization for better quality
          enableSpeakerDiarization: false,
          // 🔥 Enable word-level confidence
          enableWordConfidence: true
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
   * 🔥 HUMAN-LIKE SPEECH GENERATION
   * Uses SSML, prosody, emphasis, and best voices
   */
  async generateHumanLikeSpeech(text, language, voiceProfile, originalText = "") {
    try {
      // 🔥 TECHNIQUE 1: Use BEST available voices (WaveNet/Neural2/Journey)
      const premiumVoiceMap = {
        "en": {
          male: { 
            languageCode: "en-US", 
            name: "en-US-Journey-D",  // Premium conversational voice
            ssmlGender: "MALE" 
          },
          female: { 
            languageCode: "en-US", 
            name: "en-US-Journey-F",  // Premium conversational voice
            ssmlGender: "FEMALE" 
          }
        },
        "te": {
          male: { 
            languageCode: "te-IN", 
            name: "te-IN-Standard-B",  // Best Telugu male
            ssmlGender: "MALE" 
          },
          female: { 
            languageCode: "te-IN", 
            name: "te-IN-Standard-A",  // Best Telugu female
            ssmlGender: "FEMALE" 
          }
        },
        "hi": {
          male: { 
            languageCode: "hi-IN", 
            name: "hi-IN-Neural2-B",  // Neural voice
            ssmlGender: "MALE" 
          },
          female: { 
            languageCode: "hi-IN", 
            name: "hi-IN-Neural2-D",  // Neural voice
            ssmlGender: "FEMALE" 
          }
        },
        "es": {
          male: { 
            languageCode: "es-ES", 
            name: "es-ES-Neural2-B",
            ssmlGender: "MALE" 
          },
          female: { 
            languageCode: "es-ES", 
            name: "es-ES-Neural2-A",
            ssmlGender: "FEMALE" 
          }
        },
        "fr": {
          male: { 
            languageCode: "fr-FR", 
            name: "fr-FR-Neural2-B",
            ssmlGender: "MALE" 
          },
          female: { 
            languageCode: "fr-FR", 
            name: "fr-FR-Neural2-A",
            ssmlGender: "FEMALE" 
          }
        },
        "de": {
          male: { 
            languageCode: "de-DE", 
            name: "de-DE-Neural2-B",
            ssmlGender: "MALE" 
          },
          female: { 
            languageCode: "de-DE", 
            name: "de-DE-Neural2-A",
            ssmlGender: "FEMALE" 
          }
        }
      };

      const baseLang = language.split("-")[0];
      const genderVoices = premiumVoiceMap[baseLang] || {
        male: { languageCode: language, ssmlGender: "MALE" },
        female: { languageCode: language, ssmlGender: "FEMALE" }
      };

      const voiceConfig = voiceProfile.gender === 'male' 
        ? genderVoices.male 
        : genderVoices.female;

      // 🔥 TECHNIQUE 2: Build SSML with prosody and emphasis
      const ssmlText = this.buildSSML(text, voiceProfile);

      console.log(`🎵 Using premium ${voiceConfig.name || voiceConfig.languageCode} voice`);
      console.log(`   Pitch: ${voiceProfile.pitch}, Speed: ${voiceProfile.speed.toFixed(2)}`);

      // 🔥 TECHNIQUE 3: Advanced audio effects
      const audioEffects = [
        "telephony-class-application"  // Optimized for phone calls
      ];

      const request = {
        input: { ssml: ssmlText },  // Use SSML instead of plain text
        voice: voiceConfig,
        audioConfig: {
          audioEncoding: "MULAW",
          sampleRateHertz: 8000,
          pitch: voiceProfile.pitch,
          speakingRate: voiceProfile.speed,
          volumeGainDb: voiceProfile.energy + 1.0,  // Slightly boost
          // 🔥 Apply audio effects
          effectsProfileId: audioEffects
        }
      };

      const [response] = await this.ttsClient.synthesizeSpeech(request);
      
      console.log(`✅ Generated ${response.audioContent.length} bytes of human-like audio`);
      
      return response.audioContent;

    } catch (error) {
      console.error("❌ Human-like TTS error:", error.message);
      // Fallback to simpler voice
      return this.generateSimpleSpeech(text, language, voiceProfile);
    }
  }

  /**
   * 🔥 TECHNIQUE 4: Build SSML for natural prosody
   * Adds pauses, emphasis, and natural intonation
   */
  buildSSML(text, voiceProfile) {
    // Add pauses after punctuation for natural rhythm
    let ssml = text
      .replace(/\./g, '.<break time="300ms"/>')  // Pause after periods
      .replace(/,/g, ',<break time="200ms"/>')   // Pause after commas
      .replace(/\?/g, '?<break time="350ms"/>')  // Longer pause after questions
      .replace(/!/g, '!<break time="350ms"/>');  // Pause after exclamations

    // Add emphasis to important words (simple heuristic)
    const importantWords = ['important', 'critical', 'urgent', 'please', 'thank', 'sorry', 
                            'महत्वपूर्ण', 'कृपया', 'धन्यवाद', 'முக்கியமான', 'దయచేసి'];
    
    importantWords.forEach(word => {
      const regex = new RegExp(`\\b${word}\\b`, 'gi');
      ssml = ssml.replace(regex, `<emphasis level="moderate">${word}</emphasis>`);
    });

    // Detect questions and add appropriate intonation
    if (text.includes('?')) {
      // Questions should have rising intonation
      ssml = `<prosody pitch="+2st">${ssml}</prosody>`;
    }

    // Wrap in speak tags
    return `<speak>${ssml}</speak>`;
  }

  /**
   * Fallback simple speech (if SSML fails)
   */
  async generateSimpleSpeech(text, language, voiceProfile) {
    try {
      const voiceMap = {
        "en": { languageCode: "en-US", name: "en-US-Standard-D", ssmlGender: "MALE" },
        "te": { languageCode: "te-IN", ssmlGender: "FEMALE" },
        "hi": { languageCode: "hi-IN", ssmlGender: "FEMALE" }
      };

      const baseLang = language.split("-")[0];
      const voiceConfig = voiceMap[baseLang] || { 
        languageCode: language, 
        ssmlGender: "NEUTRAL" 
      };

      const request = {
        input: { text },
        voice: voiceConfig,
        audioConfig: {
          audioEncoding: "MULAW",
          sampleRateHertz: 8000,
          speakingRate: voiceProfile.speed || 1.0,
          pitch: voiceProfile.pitch || 0,
          volumeGainDb: 2.0
        }
      };

      const [response] = await this.ttsClient.synthesizeSpeech(request);
      return response.audioContent;
    } catch (error) {
      console.error("❌ Fallback TTS error:", error.message);
      return null;
    }
  }

  async sendToOtherUser(audioBuffer, otherConnection) {
    if (!audioBuffer || !otherConnection || !otherConnection.ws) {
      return;
    }

    if (otherConnection.ws.readyState !== 1) {
      return;
    }

    try {
      const base64Audio = audioBuffer.toString("base64");
      const chunkSize = 160;
      let chunkCount = 0;

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
      }

      const markMessage = JSON.stringify({
        event: "mark",
        streamSid: otherConnection.streamSid,
        mark: {
          name: `audio_complete_${Date.now()}`
        }
      });
      otherConnection.ws.send(markMessage);

      this.stats.audiosSent++;
      console.log(`🔊 Sent ${chunkCount} chunks of human-like audio`);

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
        if (this.userType === "creator") {
          session.creatorConnection = null;
        } else {
          session.participantConnection = null;
        }
        this.activeSessions.set(this.roomId, session);
      }
    }

    console.log("🧹 Processor cleaned up");
  }
}

module.exports = AdvancedVoiceProcessor;