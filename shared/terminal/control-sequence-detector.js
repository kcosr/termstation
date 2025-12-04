/**
 * Control Sequence Detector
 *
 * detectControlOnlySequences(bufferChunk: string, carryBuffer?: string)
 * -> { isControlOnly: boolean, carry: string, residue: string, details: { removedCount: number, hexPreview: string } }
 *
 * Identifies whether a data chunk consists solely of ANSI control sequences
 * (CSI/OSC/DCS/SS3/APC/PM and single-ESC commands) with no printable output.
 * It supports a carry buffer to handle sequences split across chunks.
 */

function toStringSafe(v) {
  return typeof v === 'string' ? v : String(v ?? '');
}

function buildHexPreview(str, maxBytes = 16) {
  try {
    const buf = Buffer.from(str, 'utf8').subarray(0, maxBytes);
    const hex = buf.toString('hex');
    return (hex.match(/../g) || []).join(' ');
  } catch (_) {
    return '';
  }
}

/**
 * Remove fully-formed ANSI sequences and return stripped content and leftover carry.
 */
function stripAnsiWithCarry(combined) {
  let removedCount = 0;

  // Remove string-type sequences first (non-nestable, explicitly terminated):
  // OSC: ESC ] ... (BEL | ST)
  combined = combined.replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, (m) => { removedCount += m.length; return ''; });
  // DCS: ESC P ... (BEL | ST)
  combined = combined.replace(/\u001bP[\s\S]*?(?:\u0007|\u001b\\)/g, (m) => { removedCount += m.length; return ''; });
  // PM: ESC ^ ... (BEL | ST)
  combined = combined.replace(/\u001b\^[\s\S]*?(?:\u0007|\u001b\\)/g, (m) => { removedCount += m.length; return ''; });
  // APC: ESC _ ... (BEL | ST)
  combined = combined.replace(/\u001b_[\s\S]*?(?:\u0007|\u001b\\)/g, (m) => { removedCount += m.length; return ''; });

  // Remove CSI sequences: ESC [ params intermediates final
  combined = combined.replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, (m) => { removedCount += m.length; return ''; });

  // Remove SS3: ESC O final
  combined = combined.replace(/\u001bO[@-~]/g, (m) => { removedCount += m.length; return ''; });

  // Remove single-ESC commands (IND/NEL/HTS/RI/DECSC/DECRC/DECID/RESET, etc.).
  // ST (ESC \\) is also covered; harmless if left.
  combined = combined.replace(/\u001b[@-Z\\^_`{|}~]/g, (m) => { removedCount += m.length; return ''; });

  // Determine carry for any unterminated sequence at the end of the (pre-stripped) input.
  // Heuristic: find the last ESC and assume anything from there could be an incomplete seq.
  let carry = '';
  const lastEsc = combined.lastIndexOf('\u001b');
  if (lastEsc !== -1) {
    // If there's any printable text after ESC, we keep it; we only carry if ESC is trailing or followed by partial introducer
    const tail = combined.slice(lastEsc);
    // Known starters that may be incomplete: ESC [, ESC ], ESC P, ESC ^, ESC _, ESC O
    const starters = [
      /^\u001b\[$/,
      /^\u001b\[[0-?]*[ -\/]*$/,
      /^\u001b\]$/,
      /^\u001bP$/,
      /^\u001b\^$/,
      /^\u001b_$/,
      /^\u001bO$/,
      /^\u001b$/
    ];
    const isPartial = starters.some((re) => re.test(tail));
    if (isPartial) {
      carry = tail;
      // Remove the carried tail from residue so it doesn't appear as output
      combined = combined.slice(0, lastEsc);
    }
  }

  return { stripped: combined, carry, removedCount };
}

export function detectControlOnlySequences(bufferChunk, carryBuffer = '') {
  try {
    const chunk = toStringSafe(bufferChunk);
    const prev = toStringSafe(carryBuffer);
    const combined = prev + chunk;

    // Fast path: if there's no ESC (and no BEL), skip heavy regex and treat as not control-only
    // This preserves carry and returns quickly for normal printable output.
    if (combined.indexOf('\u001b') === -1 && combined.indexOf('\u0007') === -1) {
      return {
        isControlOnly: false,
        carry: prev,
        residue: combined,
        details: { removedCount: 0, hexPreview: buildHexPreview(chunk) }
      };
    }

    const { stripped, carry, removedCount } = stripAnsiWithCarry(combined);

    // If stripped contains any printable characters (not C0 controls or DEL), it's not control-only
    const hasPrintable = /[^\x00-\x1F\x7F]/.test(stripped);

    return {
      isControlOnly: !hasPrintable && (removedCount > 0 || stripped.length === 0),
      carry,
      residue: stripped,
      details: {
        removedCount,
        hexPreview: buildHexPreview(chunk)
      }
    };
  } catch (_) {
    return { isControlOnly: false, carry: toStringSafe(carryBuffer), residue: '', details: { removedCount: 0, hexPreview: '' } };
  }
}
