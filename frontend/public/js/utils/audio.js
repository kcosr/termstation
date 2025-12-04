/**
 * Audio Manager - Handles notification sounds and audio preferences
 * Reusable component for managing audio notifications across the application
 */

export class AudioManager {
    constructor() {
        this.audioContext = null;
        this.sounds = new Map();
        this.preferences = {
            enabled: false,
            volume: 0.5
        };
        
        // Notification sound definitions
        this.soundConfigs = {
            info: {
                frequency: 800,
                duration: 150,
                type: 'sine'
            },
            success: {
                frequency: 880,
                duration: 200,
                type: 'sine'
            },
            warning: {
                frequency: 440,
                duration: 300,
                type: 'square'
            },
            error: {
                frequency: 220,
                duration: 500,
                type: 'sawtooth'
            }
        };
        
        this.initializeAudioContext();
    }

    /**
     * Initialize Web Audio API context
     */
    async initializeAudioContext() {
        try {
            // Create audio context on first user interaction to avoid autoplay policy issues
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
        } catch (error) {
            console.warn('AudioManager: Failed to initialize audio context:', error);
            this.audioContext = null;
        }
    }

    /**
     * Generate a notification sound
     * @param {string} type - Notification type (info, success, warning, error)
     * @param {Object} options - Optional sound configuration overrides
     */
    async playNotificationSound(type = 'info', options = {}) {
        if (!this.preferences.enabled || !this.audioContext) {
            return;
        }

        try {
            // Ensure audio context is running
            await this.initializeAudioContext();
            
            if (!this.audioContext || this.audioContext.state !== 'running') {
                console.warn('AudioManager: Audio context not available for playback');
                return;
            }

            const config = { ...this.soundConfigs[type] || this.soundConfigs.info, ...options };
            
            // Create oscillator and gain nodes
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            // Configure oscillator
            oscillator.type = config.type;
            oscillator.frequency.setValueAtTime(config.frequency, this.audioContext.currentTime);
            
            // Configure gain (volume envelope)
            const now = this.audioContext.currentTime;
            const duration = config.duration / 1000; // Convert to seconds
            
            gainNode.gain.setValueAtTime(0, now);
            gainNode.gain.linearRampToValueAtTime(this.preferences.volume, now + 0.01);
            gainNode.gain.linearRampToValueAtTime(this.preferences.volume, now + duration * 0.7);
            gainNode.gain.linearRampToValueAtTime(0, now + duration);
            
            // Connect nodes
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            // Start and stop
            oscillator.start(now);
            oscillator.stop(now + duration);
            
        } catch (error) {
            console.warn('AudioManager: Failed to play notification sound:', error);
        }
    }

    /**
     * Set audio preferences
     * @param {Object} preferences - Audio preferences object
     */
    setPreferences(preferences) {
        this.preferences = { ...this.preferences, ...preferences };
    }

    /**
     * Get current audio preferences
     * @returns {Object} Current preferences
     */
    getPreferences() {
        return { ...this.preferences };
    }

    /**
     * Enable or disable audio notifications
     * @param {boolean} enabled - Whether to enable audio
     */
    setEnabled(enabled) {
        this.preferences.enabled = enabled;
    }

    /**
     * Set audio volume
     * @param {number} volume - Volume level (0.0 to 1.0)
     */
    setVolume(volume) {
        this.preferences.volume = Math.max(0, Math.min(1, volume));
    }

    /**
     * Test audio functionality
     * @param {string} type - Notification type to test
     */
    async testSound(type = 'info') {
        await this.playNotificationSound(type);
    }

    /**
     * Initialize audio on user interaction (call this on first user click/touch)
     */
    async initializeOnUserGesture() {
        try {
            await this.initializeAudioContext();
            // Play a silent sound to unlock audio on mobile
            await this.playNotificationSound('info', { frequency: 1, duration: 1 });
        } catch (error) {
            console.warn('AudioManager: Failed to initialize on user gesture:', error);
        }
    }

    /**
     * Check if audio is supported and enabled
     * @returns {boolean} Whether audio is available
     */
    isAvailable() {
        return !!(this.audioContext && this.preferences.enabled);
    }

    /**
     * Dispose of audio resources
     */
    dispose() {
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.sounds.clear();
    }
}

// Export singleton instance
export const audioManager = new AudioManager();

// Auto-initialize on first user interaction
document.addEventListener('click', () => {
    audioManager.initializeOnUserGesture();
}, { once: true });

document.addEventListener('touchstart', () => {
    audioManager.initializeOnUserGesture();
}, { once: true, passive: true });

// Make audioManager globally available for testing
window.audioManager = audioManager;
