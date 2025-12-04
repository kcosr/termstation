/**
 * Event Bus
 * Simple event emitter for component communication
 */

export class EventBus {
    constructor() {
        this.events = {};
    }
    
    on(event, handler) {
        if (!this.events[event]) {
            this.events[event] = [];
        }
        this.events[event].push(handler);
        
        // Return unsubscribe function
        return () => {
            const index = this.events[event].indexOf(handler);
            if (index > -1) {
                this.events[event].splice(index, 1);
            }
        };
    }
    
    off(event, handler) {
        if (!this.events[event]) {
            return;
        }
        
        const index = this.events[event].indexOf(handler);
        if (index > -1) {
            this.events[event].splice(index, 1);
        }
    }
    
    emit(event, ...args) {
        if (!this.events[event]) {
            return;
        }
        
        this.events[event].forEach(handler => {
            try {
                handler(...args);
            } catch (error) {
                console.error(`Error in event handler for ${event}:`, error);
            }
        });
    }
    
    once(event, handler) {
        const wrapper = (...args) => {
            handler(...args);
            this.off(event, wrapper);
        };
        
        this.on(event, wrapper);
    }
    
    clear(event) {
        if (event) {
            delete this.events[event];
        } else {
            this.events = {};
        }
    }
}