/**
 * Shared helpers for note status text/formatting.
 */

export const NoteStatusClasses = [
  'note-status--idle',
  'note-status--saving',
  'note-status--success',
  'note-status--error',
  'note-status--warning',
  'note-status--editing'
];

export function formatRelativeTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const absMs = Math.abs(diffMs);
  const minutes = Math.round(absMs / 60000);
  if (minutes <= 1) return 'just now';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  return date.toLocaleString();
}

export function computeDefaultStatusText(state, rel = formatRelativeTime, currentUser = null) {
  if (!state) return 'Notes ready';
  if (state.pendingRemote) return 'Remote changes available';
  if (state.content !== state.lastSavedContent) return 'Unsaved changes';
  if (state.updatedAt) {
    const relative = rel(state.updatedAt);
    const shouldShowAuthor = state.updatedBy && state.updatedBy !== currentUser;
    const author = shouldShowAuthor ? ` by ${state.updatedBy}` : '';
    if (relative) return `Updated ${relative}${author}`;
    return `Updated${author}`;
  }
  return 'Notes ready';
}
