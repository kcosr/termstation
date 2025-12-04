/**
 * Shared OSC title parser
 *
 * parseOscTitles(bufferChunk: string, carryBuffer: string)
 * -> { title: string|null, carry: string }
 *
 * Handles OSC 0/2 sequences terminated by BEL (\u0007) or ST (ESC \\).
 */

export function parseOscTitles(bufferChunk, carryBuffer = '') {
  try {
    const chunk = typeof bufferChunk === 'string' ? bufferChunk : String(bufferChunk ?? '');
    const prev = typeof carryBuffer === 'string' ? carryBuffer : '';
    const combined = prev + chunk;

    const re = /\u001b](?:0|2);([\s\S]*?)(?:\u0007|\u001b\\)/g; // BEL or ST terminated
    let match;
    let foundTitle = null;
    while ((match = re.exec(combined)) !== null) {
      const t = (match[1] || '').trim();
      if (t) foundTitle = t; // use last occurrence
    }

    // Maintain carry buffer for incomplete OSC sequence
    const lastStart = combined.lastIndexOf('\u001b]');
    let carry = '';
    if (lastStart !== -1) {
      const hasTerminator = combined.indexOf('\u0007', lastStart + 2) !== -1 ||
                            combined.indexOf('\u001b\\', lastStart + 2) !== -1;
      carry = hasTerminator ? '' : combined.slice(lastStart);
    }

    return { title: foundTitle, carry };
  } catch (_) {
    return { title: null, carry: typeof carryBuffer === 'string' ? carryBuffer : '' };
  }
}

