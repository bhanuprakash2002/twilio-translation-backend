// ===========================
// 🎙️ Voice Analyzer - Extract Voice Characteristics
// Analyzes pitch, speed, and energy from audio
// ===========================

class VoiceAnalyzer {
  constructor() {
    // Cache for user voice profiles
    this.voiceProfiles = new Map();
  }

  /**
   * Analyze audio and extract voice characteristics
   * @param {Buffer} pcmBuffer - PCM audio data (16-bit, 8000Hz)
   * @param {string} userId - Unique user identifier
   * @returns {Object} Voice characteristics
   */
  analyzeVoice(pcmBuffer, userId) {
    try {
      // Extract characteristics
      const pitch = this.detectPitch(pcmBuffer);
      const speed = this.detectSpeed(pcmBuffer);
      const energy = this.detectEnergy(pcmBuffer);
      const gender = this.detectGender(pitch);

      const profile = {
        pitch: pitch,
        speed: speed,
        energy: energy,
        gender: gender,
        timestamp: Date.now()
      };

      // Store/update profile
      this.updateProfile(userId, profile);

      return profile;
    } catch (error) {
      console.error("❌ Voice analysis error:", error.message);
      return this.getDefaultProfile();
    }
  }

  /**
   * Detect pitch (fundamental frequency) from audio
   * @param {Buffer} pcmBuffer
   * @returns {number} Pitch value (-20 to +20, 0 = normal)
   */
  detectPitch(pcmBuffer) {
    // Convert buffer to samples
    const samples = [];
    for (let i = 0; i < pcmBuffer.length; i += 2) {
      samples.push(pcmBuffer.readInt16LE(i));
    }

    // Simple autocorrelation for pitch detection
    const sampleRate = 8000;
    const minPeriod = Math.floor(sampleRate / 500); // 500 Hz max
    const maxPeriod = Math.floor(sampleRate / 50);  // 50 Hz min

    let maxCorrelation = 0;
    let bestPeriod = minPeriod;

    for (let period = minPeriod; period <= maxPeriod; period++) {
      let correlation = 0;
      for (let i = 0; i < samples.length - period; i++) {
        correlation += samples[i] * samples[i + period];
      }

      if (correlation > maxCorrelation) {
        maxCorrelation = correlation;
        bestPeriod = period;
      }
    }

    // Convert period to frequency
    const frequency = sampleRate / bestPeriod;

    // Map frequency to TTS pitch adjustment (-20 to +20)
    // Male: 85-180 Hz, Female: 165-255 Hz
    // Map to -20 (very low) to +20 (very high)
    let pitchAdjustment = 0;
    
    if (frequency < 120) {
      // Very low (deep male voice)
      pitchAdjustment = -10 + ((frequency - 85) / 35) * 10;
    } else if (frequency < 165) {
      // Low to mid (normal male)
      pitchAdjustment = -5 + ((frequency - 120) / 45) * 5;
    } else if (frequency < 210) {
      // Mid to high (female or high male)
      pitchAdjustment = 0 + ((frequency - 165) / 45) * 10;
    } else {
      // High (high female voice)
      pitchAdjustment = 10 + ((frequency - 210) / 45) * 10;
    }

    // Clamp between -20 and +20
    return Math.max(-20, Math.min(20, Math.round(pitchAdjustment)));
  }

  /**
   * Detect speaking speed from audio
   * @param {Buffer} pcmBuffer
   * @returns {number} Speed multiplier (0.75 to 1.5)
   */
  detectSpeed(pcmBuffer) {
    // Count zero crossings to estimate speech rate
    let zeroCrossings = 0;
    let prevSample = 0;

    for (let i = 0; i < pcmBuffer.length; i += 2) {
      const sample = pcmBuffer.readInt16LE(i);
      if ((prevSample >= 0 && sample < 0) || (prevSample < 0 && sample >= 0)) {
        zeroCrossings++;
      }
      prevSample = sample;
    }

    // Normalize to rate (crossings per second)
    const durationSeconds = pcmBuffer.length / 2 / 8000;
    const crossingRate = zeroCrossings / durationSeconds;

    // Map crossing rate to speaking speed
    // Typical: 100-300 crossings/sec
    // Slow: < 150, Normal: 150-250, Fast: > 250
    let speedMultiplier = 1.0;

    if (crossingRate < 150) {
      // Slow speaker
      speedMultiplier = 0.8 + (crossingRate / 150) * 0.2;
    } else if (crossingRate < 250) {
      // Normal speaker
      speedMultiplier = 1.0;
    } else {
      // Fast speaker
      speedMultiplier = 1.0 + ((crossingRate - 250) / 250) * 0.3;
    }

    // Clamp between 0.75 and 1.5
    return Math.max(0.75, Math.min(1.5, speedMultiplier));
  }

  /**
   * Detect audio energy (volume level)
   * @param {Buffer} pcmBuffer
   * @returns {number} Energy in dB (-10 to +10)
   */
  detectEnergy(pcmBuffer) {
    let sumSquares = 0;
    let sampleCount = 0;

    for (let i = 0; i < pcmBuffer.length; i += 2) {
      const sample = pcmBuffer.readInt16LE(i);
      sumSquares += sample * sample;
      sampleCount++;
    }

    const rms = Math.sqrt(sumSquares / sampleCount);
    
    // Convert to dB and map to volume adjustment
    // Quiet: < 1000, Normal: 1000-3000, Loud: > 3000
    let volumeAdjustment = 0;

    if (rms < 1000) {
      // Quiet speaker
      volumeAdjustment = 5 + (rms / 1000) * 5;
    } else if (rms < 3000) {
      // Normal volume
      volumeAdjustment = 0;
    } else {
      // Loud speaker
      volumeAdjustment = -5 - ((rms - 3000) / 3000) * 5;
    }

    // Clamp between -10 and +10
    return Math.max(-10, Math.min(10, Math.round(volumeAdjustment)));
  }

  /**
   * Detect gender from pitch
   * @param {number} pitch
   * @returns {string} 'male' or 'female'
   */
  detectGender(pitch) {
    // Pitch < 0 usually indicates male voice
    // Pitch > 0 usually indicates female voice
    return pitch < 0 ? 'male' : 'female';
  }

  /**
   * Update user's voice profile with running average
   * @param {string} userId
   * @param {Object} newProfile
   */
  updateProfile(userId, newProfile) {
    const existing = this.voiceProfiles.get(userId);

    if (existing) {
      // Running average for smoother results
      const updated = {
        pitch: Math.round((existing.pitch * 0.7 + newProfile.pitch * 0.3)),
        speed: existing.speed * 0.7 + newProfile.speed * 0.3,
        energy: Math.round((existing.energy * 0.7 + newProfile.energy * 0.3)),
        gender: newProfile.gender,
        timestamp: Date.now(),
        samples: (existing.samples || 1) + 1
      };
      this.voiceProfiles.set(userId, updated);
    } else {
      this.voiceProfiles.set(userId, {
        ...newProfile,
        samples: 1
      });
    }
  }

  /**
   * Get stored voice profile for user
   * @param {string} userId
   * @returns {Object} Voice profile
   */
  getProfile(userId) {
    return this.voiceProfiles.get(userId) || this.getDefaultProfile();
  }

  /**
   * Get default profile for new users
   * @returns {Object}
   */
  getDefaultProfile() {
    return {
      pitch: 0,
      speed: 1.0,
      energy: 0,
      gender: 'neutral',
      timestamp: Date.now()
    };
  }

  /**
   * Clean up old profiles
   */
  cleanup(userId) {
    this.voiceProfiles.delete(userId);
  }

  /**
   * Get all profiles (for debugging)
   */
  getAllProfiles() {
    const profiles = {};
    for (const [userId, profile] of this.voiceProfiles.entries()) {
      profiles[userId] = profile;
    }
    return profiles;
  }
}

module.exports = VoiceAnalyzer;