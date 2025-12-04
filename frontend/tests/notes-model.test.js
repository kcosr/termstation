import test from 'node:test';
import assert from 'node:assert/strict';
import { NotesModel } from '../public/js/modules/terminal/notes-model.js';
import { computeDefaultStatusText } from '../public/js/modules/terminal/note-status.js';

function createTimerStub() {
  const queue = [];
  return {
    setTimer: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      queue.push(handle);
      return handle;
    },
    clearTimer: (handle) => {
      if (!handle) return;
      handle.cleared = true;
    },
    flush: () => {
      while (queue.length > 0) {
        const handle = queue.shift();
        if (!handle.cleared) {
          handle.cleared = true;
          handle.fn();
        }
      }
    }
  };
}

test('saveNow updates optimistic state and resets status after delay', async () => {
  const timers = createTimerStub();
  const savedPayloads = [];
  const model = new NotesModel({
    id: 'session:test',
    saveFn: async ({ content, version }) => {
      savedPayloads.push({ content, version });
      return {
        content: content.toUpperCase(),
        version: version + 1,
        updated_at: '2024-01-01T00:00:00Z',
        updated_by: 'tester'
      };
    },
    computeStatusText: computeDefaultStatusText,
    relativeTimeFormatter: () => 'just now',
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    getCurrentUser: () => 'tester',
    now: () => 1700000000000
  });

  const statuses = [];
  model.on('status', (status) => statuses.push({ ...status }));

  model.setContent('draft note');
  await model.saveNow();

  assert.deepEqual(savedPayloads, [{ content: 'draft note', version: 0 }]);

  const state = model.getState();
  assert.equal(state.lastSavedContent, 'DRAFT NOTE');
  assert.equal(state.version, 1);
  assert.equal(state.pendingSave, null);
  assert.equal(state.lastSyncSignature.version, 1);

  const latestStatus = statuses.at(-1);
  assert.equal(latestStatus.state, 'success');
  assert.equal(latestStatus.message, 'Saved');

  timers.flush();
  const idleStatus = model.getStatus();
  assert.equal(idleStatus.state, 'idle');
  assert.equal(idleStatus.message, 'Updated just now');
});

test('conflict handling records pending remote snapshot', async () => {
  const timers = createTimerStub();
  const model = new NotesModel({
    id: 'session:conflict',
    saveFn: async () => {
      const error = new Error('conflict');
      error.status = 409;
      error.context = {
        note: {
          content: 'server copy',
          version: 7,
          updated_at: '2024-01-02T10:00:00Z',
          updated_by: 'other-user'
        }
      };
      throw error;
    },
    computeStatusText: computeDefaultStatusText,
    relativeTimeFormatter: () => 'moment ago',
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });

  model.setContent('local change');
  const result = await model.saveNow();
  assert.equal(result, null);

  const state = model.getState();
  assert(state.pendingRemote, 'expected pending remote snapshot');
  assert.equal(state.pendingRemote.content, 'server copy');
  assert.equal(state.pendingRemote.version, 7);
  assert.equal(model.getStatus().state, 'error');
  assert.equal(model.getStatus().showLoadButton, true);
});

test('applyPendingRemote merges snapshot and sets success status', () => {
  const timers = createTimerStub();
  const model = new NotesModel({
    id: 'session:apply',
    computeStatusText: computeDefaultStatusText,
    relativeTimeFormatter: () => 'moments ago',
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer
  });

  model.markPendingRemote({
    content: 'server value',
    version: 3,
    updated_at: '2024-01-03T09:00:00Z',
    updated_by: 'sync-user'
  });

  const applied = model.applyPendingRemote({
    statusState: 'success',
    statusMessage: 'Loaded latest changes',
    statusDelay: 0
  });

  assert(applied, 'expected pending remote to be applied');
  const state = model.getState();
  assert.equal(state.content, 'server value');
  assert.equal(state.lastSavedContent, 'server value');
  assert.equal(state.pendingRemote, null);
  assert.equal(state.version, 3);
  assert.equal(model.getStatus().state, 'success');
  assert.equal(model.getStatus().message, 'Loaded latest changes');
});
