/**
 * Simple State Store - Centralized state management
 * Provides reactive state updates with subscription mechanism
 */
export class Store {
    constructor(initialState = {}) {
        this.state = this.deepClone(initialState);
        this.listeners = new Map();
        this.globalListeners = new Set();
        this.history = [];
        this.maxHistorySize = 50;
        this.transactionDepth = 0;
        this.pendingUpdates = null;
    }

    /**
     * Get current state or a specific path
     * @param {string} path - Optional dot-notation path to state value
     * @returns {*} State value
     */
    getState(path = null) {
        if (!path) {
            return this.deepClone(this.state);
        }
        
        const value = this.getValueByPath(this.state, path);
        return this.deepClone(value);
    }

    /**
     * Set state updates
     * @param {Object|Function} updates - State updates or updater function
     */
    setState(updates) {
        const prevState = this.deepClone(this.state);
        
        if (typeof updates === 'function') {
            updates = updates(this.getState());
        }

        // Handle transaction mode
        if (this.transactionDepth > 0) {
            this.pendingUpdates = { ...this.pendingUpdates, ...updates };
            return;
        }

        // Apply updates
        this.state = { ...this.state, ...updates };
        
        // Add to history
        this.addToHistory(prevState, this.state, updates);
        
        // Notify listeners
        this.notifyListeners(prevState, this.state, updates);
    }

    /**
     * Update a specific path in the state
     * @param {string} path - Dot-notation path
     * @param {*} value - New value
     */
    setPath(path, value) {
        const prevState = this.deepClone(this.state);
        const newState = this.deepClone(this.state);
        
        this.setValueByPath(newState, path, value);
        
        // Handle transaction mode
        if (this.transactionDepth > 0) {
            if (!this.pendingUpdates) {
                this.pendingUpdates = {};
            }
            this.setValueByPath(this.pendingUpdates, path, value);
            return;
        }

        this.state = newState;
        
        // Add to history
        this.addToHistory(prevState, this.state, { [path]: value });
        
        // Notify listeners
        this.notifyListeners(prevState, this.state, { [path]: value });
    }

    /**
     * Subscribe to state changes
     * @param {string|Function} selectorOrListener - Path selector or listener function
     * @param {Function} listener - Listener function (if selector provided)
     * @returns {Function} Unsubscribe function
     */
    subscribe(selectorOrListener, listener) {
        if (typeof selectorOrListener === 'function') {
            // Global listener
            this.globalListeners.add(selectorOrListener);
            return () => this.globalListeners.delete(selectorOrListener);
        }

        // Path-specific listener
        const selector = selectorOrListener;
        if (!this.listeners.has(selector)) {
            this.listeners.set(selector, new Set());
        }
        
        this.listeners.get(selector).add(listener);
        
        // Return unsubscribe function
        return () => {
            const selectorListeners = this.listeners.get(selector);
            if (selectorListeners) {
                selectorListeners.delete(listener);
                if (selectorListeners.size === 0) {
                    this.listeners.delete(selector);
                }
            }
        };
    }

    /**
     * Begin a transaction - batch multiple updates
     */
    beginTransaction() {
        this.transactionDepth++;
        if (this.transactionDepth === 1) {
            this.pendingUpdates = {};
        }
    }

    /**
     * Commit a transaction - apply all pending updates
     */
    commitTransaction() {
        if (this.transactionDepth <= 0) {
            console.warn('No transaction to commit');
            return;
        }

        this.transactionDepth--;
        
        if (this.transactionDepth === 0 && this.pendingUpdates) {
            const updates = this.pendingUpdates;
            this.pendingUpdates = null;
            this.setState(updates);
        }
    }

    /**
     * Rollback a transaction - discard pending updates
     */
    rollbackTransaction() {
        if (this.transactionDepth <= 0) {
            console.warn('No transaction to rollback');
            return;
        }

        this.transactionDepth = 0;
        this.pendingUpdates = null;
    }

    /**
     * Reset state to initial or provided state
     * @param {Object} newState - Optional new state
     */
    reset(newState = {}) {
        const prevState = this.deepClone(this.state);
        this.state = this.deepClone(newState);
        this.history = [];
        this.notifyListeners(prevState, this.state, newState);
    }

    /**
     * Get state history
     * @returns {Array} State history entries
     */
    getHistory() {
        return [...this.history];
    }

    /**
     * Undo last state change
     * @returns {boolean} Whether undo was successful
     */
    undo() {
        if (this.history.length === 0) {
            return false;
        }

        const lastEntry = this.history.pop();
        const prevState = this.deepClone(this.state);
        this.state = this.deepClone(lastEntry.prevState);
        
        // Notify without adding to history
        this.notifyListeners(prevState, this.state, {});
        return true;
    }

    /**
     * Create a derived store that computes from this store
     * @param {Function} selector - Selector function
     * @returns {DerivedStore} Derived store instance
     */
    derive(selector) {
        return new DerivedStore(this, selector);
    }

    /**
     * Notify all relevant listeners of state changes
     * @private
     */
    notifyListeners(prevState, newState, updates) {
        // Notify global listeners
        this.globalListeners.forEach(listener => {
            try {
                listener(newState, prevState, updates);
            } catch (error) {
                console.error('Error in global state listener:', error);
            }
        });

        // Notify path-specific listeners
        this.listeners.forEach((listeners, selector) => {
            const prevValue = this.getValueByPath(prevState, selector);
            const newValue = this.getValueByPath(newState, selector);
            
            if (!this.deepEqual(prevValue, newValue)) {
                listeners.forEach(listener => {
                    try {
                        listener(newValue, prevValue, selector);
                    } catch (error) {
                        console.error(`Error in state listener for '${selector}':`, error);
                    }
                });
            }
        });
    }

    /**
     * Add state change to history
     * @private
     */
    addToHistory(prevState, newState, updates) {
        this.history.push({
            prevState,
            newState,
            updates,
            timestamp: Date.now()
        });

        // Limit history size
        if (this.history.length > this.maxHistorySize) {
            this.history.shift();
        }
    }

    /**
     * Get value by dot-notation path
     * @private
     */
    getValueByPath(obj, path) {
        return path.split('.').reduce((current, key) => {
            return current?.[key];
        }, obj);
    }

    /**
     * Set value by dot-notation path
     * @private
     */
    setValueByPath(obj, path, value) {
        const keys = path.split('.');
        const lastKey = keys.pop();
        
        const target = keys.reduce((current, key) => {
            if (!current[key]) {
                current[key] = {};
            }
            return current[key];
        }, obj);
        
        target[lastKey] = value;
    }

    /**
     * Deep clone an object
     * @private
     */
    deepClone(obj) {
        if (obj === null || typeof obj !== 'object') {
            return obj;
        }
        
        if (obj instanceof Date) {
            return new Date(obj);
        }
        
        if (obj instanceof Array) {
            return obj.map(item => this.deepClone(item));
        }
        
        if (obj instanceof Set) {
            return new Set([...obj].map(item => this.deepClone(item)));
        }
        
        if (obj instanceof Map) {
            const cloned = new Map();
            obj.forEach((value, key) => {
                cloned.set(this.deepClone(key), this.deepClone(value));
            });
            return cloned;
        }
        
        const cloned = {};
        Object.keys(obj).forEach(key => {
            cloned[key] = this.deepClone(obj[key]);
        });
        
        return cloned;
    }

    /**
     * Deep equality check
     * @private
     */
    deepEqual(a, b) {
        if (a === b) return true;
        
        if (a === null || b === null) return false;
        if (typeof a !== 'object' || typeof b !== 'object') return false;
        
        // Handle Sets
        if (a instanceof Set && b instanceof Set) {
            if (a.size !== b.size) return false;
            for (let item of a) {
                if (!b.has(item)) return false;
            }
            return true;
        }
        
        // Handle Maps
        if (a instanceof Map && b instanceof Map) {
            if (a.size !== b.size) return false;
            for (let [key, value] of a) {
                if (!b.has(key) || !this.deepEqual(value, b.get(key))) {
                    return false;
                }
            }
            return true;
        }
        
        // Handle Arrays
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) return false;
            return a.every((item, index) => this.deepEqual(item, b[index]));
        }
        
        // Handle regular objects
        if (Array.isArray(a) || Array.isArray(b)) return false;
        if (a instanceof Set || a instanceof Map || b instanceof Set || b instanceof Map) return false;
        
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        
        if (keysA.length !== keysB.length) return false;
        
        return keysA.every(key => {
            return keysB.includes(key) && this.deepEqual(a[key], b[key]);
        });
    }
}

/**
 * Derived Store - Computed values from main store
 */
export class DerivedStore {
    constructor(parentStore, selector) {
        this.parentStore = parentStore;
        this.selector = selector;
        this.listeners = new Set();
        this.cachedValue = null;
        this.isSubscribed = false;
        this.unsubscribe = null;
    }

    /**
     * Get computed value
     * @returns {*} Computed value
     */
    getValue() {
        return this.selector(this.parentStore.getState());
    }

    /**
     * Subscribe to derived value changes
     * @param {Function} listener - Listener function
     * @returns {Function} Unsubscribe function
     */
    subscribe(listener) {
        this.listeners.add(listener);
        
        // Subscribe to parent store if not already
        if (!this.isSubscribed) {
            this.cachedValue = this.getValue();
            this.unsubscribe = this.parentStore.subscribe((state) => {
                const newValue = this.selector(state);
                if (!this.deepEqual(newValue, this.cachedValue)) {
                    const prevValue = this.cachedValue;
                    this.cachedValue = newValue;
                    this.notifyListeners(newValue, prevValue);
                }
            });
            this.isSubscribed = true;
        }
        
        // Return unsubscribe function
        return () => {
            this.listeners.delete(listener);
            
            // Unsubscribe from parent if no more listeners
            if (this.listeners.size === 0 && this.isSubscribed) {
                this.unsubscribe();
                this.isSubscribed = false;
                this.cachedValue = null;
            }
        };
    }

    /**
     * Notify listeners of value changes
     * @private
     */
    notifyListeners(newValue, prevValue) {
        this.listeners.forEach(listener => {
            try {
                listener(newValue, prevValue);
            } catch (error) {
                console.error('Error in derived store listener:', error);
            }
        });
    }

    /**
     * Deep equality check (borrowed from parent)
     * @private
     */
    deepEqual(a, b) {
        if (a === b) return true;
        
        if (a === null || b === null) return false;
        if (typeof a !== 'object' || typeof b !== 'object') return false;
        
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        
        if (keysA.length !== keysB.length) return false;
        
        return keysA.every(key => {
            return keysB.includes(key) && this.deepEqual(a[key], b[key]);
        });
    }
}

// Export singleton instance for application state
export const appStore = new Store({
    // Application state
    sessions: [],
    activeSessions: new Map(),
    currentSessionId: null,

    auth: {
        username: '',
        features: {}
    },
    
    // UI state
    ui: {
        modalVisible: false,
        searchQuery: '',
        filterStatus: 'all',
        sidebarCollapsed: false,
        theme: 'auto'
    },
    
    // Connection state
    connection: {
        websocket: 'disconnected',
        api: 'ready'
    },
    
    // User preferences
    preferences: {
        terminal: {
            fontSize: 14,
            fontFamily: 'monospace',
            cursorBlink: true,
            scrollback: 1000,
            // Dynamic title behavior: 'always' | 'never' | 'ifUnset'
            dynamicTitleMode: 'ifUnset',
            // Filters (default ON)
            filterOscColors: true,
            collapseNakedRgbRuns: true,
            // New: auto-attach on session select
            autoAttachOnSelect: true
        },
        links: {
            searchRevealGroupLinks: true,
            showSessionTabs: true,
            // Controls visibility of the session toolbar links dropdown/menu
            showSessionToolbarMenu: false,
            sessionTabMaxWidth: 200
        },
        display: {
            // Controls whether the sidebar activity indicator (dot) is shown
            showActivityIndicator: true,
            // Controls whether container child shells render under parents in sidebar
            showContainerShellsInSidebar: false,
            // Controls whether the Send Text modal closes after submit (default: false = keep open)
            closeSendTextOnSubmit: false
        },
        notes: {
            showSessionTab: true,
            showWorkspaceTab: true
        },
        notifications: {
            enabled: false,
            sound: false,
            // Show toast popups when input is injected/scheduled remotely
            showScheduledInput: true,
            // Per-level configuration for show/sound behavior
            levels: {
                info: { show: true, sound: true },
                success: { show: true, sound: true },
                warning: { show: true, sound: true },
                error: { show: true, sound: true }
            }
        },
        // Debug preferences
        debug: {
            consoleEnabled: false,
            websocketLogs: false,
            registryLogs: false,
            // Additional categorized debug flags (all default to false)
            apiLogs: false,
            stateStoreLogs: false,
            appLogs: false,
            settingsLogs: false,
            sessionTabsLogs: false,
            sessionListLogs: false,
            terminalLogs: false,
            terminalSessionLogs: false,
            terminalManagerLogs: false,
            tabManagerLogs: false,
            responsiveToolbarLogs: false,
            mobileViewportLogs: false,
            mobileDetectionLogs: false,
            mobileTouchLogs: false,
            notesLogs: false,
            configLogs: false
            , ansiOscLogs: false
        }
    }
});

// Seed UI theme from document attribute so early bootstrap (e.g., auth modal)
// respects the preloaded desktop theme before async settings finish loading.
try {
    const initialTheme = document.documentElement.getAttribute('data-theme');
    if (initialTheme && initialTheme.trim() !== '') {
        appStore.setPath('ui.theme', initialTheme.trim());
    }
} catch (_) {}
