# Comprehensive State Store Integration Plan

## Overview
This document outlines the extensive work required to properly integrate the state store throughout the Terminal Manager application. The current implementation has deeply embedded local state that needs systematic migration.

## Current State Problems

### 1. Scattered State Management
```javascript
// manager.js - Multiple local state variables
this.sessions = new Map();           // Local session instances
this.currentSession = null;          // Current session reference
this.currentSessionId = null;        // Current session ID
this.tabSelections = { active: null, inactive: null }; // Tab state
this.searchQuery = '';              // Search state
this.isCreatingSession = false;     // UI state
this.pendingSelectSessionId = null; // Async state

// session-list.js - Duplicate state management
this.sessions = new Map();          // DOM elements map
this.sessionData = new Map();       // Session data map
this.activeSessionId = null;        // Active session tracking
this.currentFilter = 'active';     // Filter state
```

### 2. State Synchronization Issues
- Session data exists in multiple places
- UI state not centralized
- No reactive updates between components
- Manual state synchronization required

### 3. No Persistence
- User preferences lost on refresh
- Search queries not preserved
- UI state resets

## Required State Structure

### Core State Schema
```javascript
{
  // Session Management
  sessions: {
    // Raw session data from API (single source of truth)
    data: [
      {
        session_id: "abc123",
        title: "My Session",
        command: "/bin/bash",
        working_directory: "/home/user",
        is_active: true,
        created_at: 1234567890,
        // ... other API fields
      }
    ],
    // Live terminal instances for active sessions only
    instances: {
      "abc123": TerminalSession,
      "def456": TerminalSession
    },
    // UI state
    current: "abc123",           // Currently displayed session
    tabSelections: {
      active: "abc123",          // Last selected in active tab
      inactive: "ghi789"         // Last selected in inactive tab
    },
    pendingSelect: null,         // Session to auto-select after creation
    isCreating: false           // Prevent double session creation
  },

  // UI State
  ui: {
    // Modals
    modals: {
      newSession: false,
      terminateConfirm: false,
      deleteConfirm: false,
      errorModal: false
    },
    // Search & Filtering
    search: {
      query: "",
      isActive: false,
      results: []
    },
    filters: {
      current: "active",         // active | inactive
      available: ["active", "inactive"]
    },
    // Layout
    layout: {
      sidebarCollapsed: false,
      mobileMenuVisible: false,
      terminalControlsVisible: true
    },
    // Terminal-specific UI
    terminal: {
      currentView: "live",       // live | history
      historyViewer: null,       // History viewer instance
      placeholder: "Select a session or create a new terminal"
    }
  },

  // Connection State
  connection: {
    websocket: {
      state: "disconnected",     // disconnected | connecting | connected | error
      lastConnected: null,
      reconnectAttempts: 0,
      clientId: null
    },
    api: {
      state: "ready",           // ready | loading | error
      lastRequest: null,
      errorCount: 0
    }
  },

  // User Preferences (persisted to localStorage)
  preferences: {
    terminal: {
      fontSize: 14,
      fontFamily: "monospace",
      cursorBlink: true,
      scrollback: 1000,
      theme: "dark"
    },
    ui: {
      defaultWorkingDirectory: "~",
      autoSelectNewSession: true,
      confirmSessionDeletion: true,
      showTerminalControls: true
    },
    notifications: {
      enabled: true,
      sound: false,
      sessionTerminated: true,
      sessionCreated: true
    }
  },

  // Application Metadata
  app: {
    version: null,
    isInitialized: false,
    lastUpdate: null,
    debugMode: false
  }
}
```

## Migration Strategy

### Phase 1: State Structure Setup
1. **Update store.js with comprehensive state schema**
2. **Add state persistence layer for preferences**
3. **Create state validation and migration utilities**

### Phase 2: Session Management Migration
1. **Replace `this.sessions` Map with store-based session instances**
   ```javascript
   // Before
   this.sessions.get(sessionId)
   
   // After  
   appStore.getState('sessions.instances')[sessionId]
   ```

2. **Migrate session data management from SessionList**
   ```javascript
   // Before
   this.sessionList.sessionData.get(sessionId)
   
   // After
   appStore.getState('sessions.data').find(s => s.session_id === sessionId)
   ```

3. **Centralize current session tracking**
   ```javascript
   // Before
   this.currentSession = session;
   this.currentSessionId = sessionId;
   
   // After
   appStore.setState({ 
     'sessions.current': sessionId,
     'sessions.instances': { ...instances, [sessionId]: session }
   });
   ```

### Phase 3: UI State Migration
1. **Modal state management**
   ```javascript
   // Before
   this.showNewSessionModal()
   
   // After
   appStore.setState({ 'ui.modals.newSession': true });
   ```

2. **Search state management**
   ```javascript
   // Before
   this.searchQuery = query;
   
   // After
   appStore.setState({ 'ui.search.query': query });
   ```

3. **Filter and tab state**
   ```javascript
   // Before
   this.tabSelections.active = sessionId;
   
   // After
   appStore.setState({ 'sessions.tabSelections.active': sessionId });
   ```

### Phase 4: Reactive Component Updates
1. **Subscribe components to state changes**
   ```javascript
   // In TerminalManager.init()
   this.subscriptions = [
     appStore.subscribe('sessions.current', this.onCurrentSessionChange.bind(this)),
     appStore.subscribe('sessions.data', this.onSessionsChange.bind(this)),
     appStore.subscribe('ui.search.query', this.onSearchQueryChange.bind(this)),
     appStore.subscribe('ui.filters.current', this.onFilterChange.bind(this))
   ];
   ```

2. **Convert direct DOM manipulation to state-driven updates**
   ```javascript
   onCurrentSessionChange(sessionId, prevSessionId) {
     if (prevSessionId) {
       // Cleanup previous session UI
     }
     if (sessionId) {
       // Setup new session UI
       this.displaySession(sessionId);
     }
   }
   ```

3. **Remove manual state synchronization**

### Phase 5: SessionList Component Refactor
1. **Remove internal state management**
2. **Make SessionList purely reactive to store state**
3. **Convert to event-driven updates**

```javascript
class SessionList {
  constructor(container, store) {
    this.container = container;
    this.store = store;
    
    // Subscribe to state changes
    this.subscriptions = [
      store.subscribe('sessions.data', this.renderSessions.bind(this)),
      store.subscribe('sessions.current', this.updateActiveSession.bind(this)),
      store.subscribe('ui.filters.current', this.updateFilter.bind(this))
    ];
  }
  
  renderSessions(sessions) {
    // Clear and rebuild session list
    // No internal state management
  }
}
```

## Detailed Implementation Steps

### Step 1: Enhanced Store Setup
```javascript
// Add to store.js
export class PersistentStore extends Store {
  constructor(initialState, persistenceKey = 'app_state') {
    super(initialState);
    this.persistenceKey = persistenceKey;
    this.persistedPaths = [
      'preferences',
      'ui.layout.sidebarCollapsed',
      'connection.websocket.clientId'
    ];
    this.loadPersistedState();
    this.setupAutoPersistence();
  }
  
  loadPersistedState() {
    try {
      const saved = localStorage.getItem(this.persistenceKey);
      if (saved) {
        const parsed = JSON.parse(saved);
        this.setState(parsed);
      }
    } catch (error) {
      console.warn('Failed to load persisted state:', error);
    }
  }
  
  setupAutoPersistence() {
    this.subscribe((newState, prevState) => {
      const toPersist = {};
      this.persistedPaths.forEach(path => {
        const value = this.getValueByPath(newState, path);
        if (value !== undefined) {
          this.setValueByPath(toPersist, path, value);
        }
      });
      
      localStorage.setItem(this.persistenceKey, JSON.stringify(toPersist));
    });
  }
}
```

### Step 2: Migration Utilities
```javascript
// migrationUtils.js
export class StateMigrator {
  static migrateSessionsFromManager(manager) {
    const sessions = [];
    const instances = {};
    
    // Convert Map to arrays/objects
    manager.sessionList.sessionData.forEach((data, id) => {
      sessions.push(data);
    });
    
    manager.sessions.forEach((instance, id) => {
      instances[id] = instance;
    });
    
    return {
      'sessions.data': sessions,
      'sessions.instances': instances,
      'sessions.current': manager.currentSessionId,
      'sessions.tabSelections': manager.tabSelections
    };
  }
  
  static migrateUIState(manager) {
    return {
      'ui.search.query': manager.searchQuery,
      'ui.filters.current': manager.sessionList.currentFilter
    };
  }
}
```

### Step 3: Component Integration Pattern
```javascript
// Base class for state-aware components
export class StateAwareComponent {
  constructor(store) {
    this.store = store;
    this.subscriptions = [];
  }
  
  subscribe(path, callback) {
    const unsubscribe = this.store.subscribe(path, callback);
    this.subscriptions.push(unsubscribe);
    return unsubscribe;
  }
  
  setState(updates) {
    this.store.setState(updates);
  }
  
  getState(path) {
    return this.store.getState(path);
  }
  
  cleanup() {
    this.subscriptions.forEach(unsubscribe => unsubscribe());
    this.subscriptions = [];
  }
}
```

## Testing Strategy

### Unit Tests
1. **State store operations**
2. **Component state subscriptions**
3. **State persistence**
4. **Migration utilities**

### Integration Tests
1. **Session creation/deletion workflows**
2. **Search and filtering**
3. **Modal state management**
4. **WebSocket state synchronization**

### Performance Tests
1. **Large session lists (100+ sessions)**
2. **Rapid state updates**
3. **Memory usage with subscriptions**

## Rollback Plan

### Gradual Migration
1. **Keep existing state alongside new store initially**
2. **Dual-write to both systems during transition**
3. **Component-by-component migration**
4. **Feature flags for rollback**

### Validation
1. **State consistency checks**
2. **Functional regression tests**
3. **Performance benchmarks**

## Benefits After Migration

### Developer Experience
- **Single source of truth** for all application state
- **Predictable state updates** with reactive components
- **Easier debugging** with centralized state
- **Time travel debugging** with state history

### User Experience  
- **Persistent preferences** across sessions
- **Better performance** with optimized updates
- **Consistent UI state** across components
- **Improved reliability** with state validation

### Maintainability
- **Reduced coupling** between components
- **Easier testing** with mockable state
- **Clear data flow** with reactive subscriptions
- **Simplified state logic** without manual synchronization

## Estimated Effort

- **Phase 1 (Setup)**: 4 hours
- **Phase 2 (Session Migration)**: 8 hours
- **Phase 3 (UI Migration)**: 6 hours
- **Phase 4 (Reactive Updates)**: 10 hours
- **Phase 5 (SessionList Refactor)**: 6 hours
- **Testing & Polish**: 8 hours

**Total: ~42 hours** for complete state store integration

## Risk Assessment

### High Risk
- **Breaking existing functionality** during migration
- **Performance degradation** with excessive subscriptions
- **State synchronization bugs** between old and new systems

### Medium Risk
- **Memory leaks** from unmanaged subscriptions
- **localStorage quota** issues with state persistence
- **Complex state updates** causing infinite loops

### Mitigation
- **Incremental migration** with feature flags
- **Comprehensive testing** at each phase
- **Performance monitoring** during transition
- **Clear rollback procedures** for each phase

This plan provides a roadmap for transforming the Terminal Manager from scattered local state to a robust, centralized state management system.
