const MAX_TOOL_RESULT_CHARS = 24_000;
const MAX_STRING_CHARS = 2_000;
const TRUNCATED = '…[截断]';

function boundedString(value, state) {
  let output = value.length > MAX_STRING_CHARS ? value.slice(0, MAX_STRING_CHARS) + TRUNCATED : value;
  if (JSON.stringify(output).length > state.remaining) {
    let low = 0, high = Math.min(value.length, MAX_STRING_CHARS);
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (JSON.stringify(value.slice(0, middle) + TRUNCATED).length <= state.remaining) low = middle;
      else high = middle - 1;
    }
    output = value.slice(0, low) + TRUNCATED;
  }
  state.remaining -= JSON.stringify(output).length + 2;
  if (output !== value) state.truncated = true;
  return output;
}

function boundedValue(value, state, depth = 0) {
  if (typeof value === 'string') return boundedString(value, state);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    const safe = typeof value === 'number' && !Number.isFinite(value) ? null : value;
    state.remaining -= JSON.stringify(safe).length + 2;
    return safe;
  }
  if (typeof value !== 'object') return boundedString(String(value), state);
  if (state.seen.has(value) || depth >= 8 || state.remaining < 32) {
    state.truncated = true;
    return '[已截断]';
  }
  state.seen.add(value);
  if (Array.isArray(value)) {
    const output = [];
    for (const item of value) {
      if (output.length >= 30 || state.remaining < 64) { state.truncated = true; break; }
      output.push(boundedValue(item, state, depth + 1));
      state.remaining -= 1;
    }
    if (output.length < value.length && state.remaining > 32) output.push(`…另有 ${value.length - output.length} 项`);
    state.remaining -= 2;
    return output;
  }
  const output = {};
  let count = 0;
  const add = key => {
    if (count >= 40 || state.remaining < 64) { state.truncated = true; return false; }
    const safeKey = boundedString(key, state);
    Object.defineProperty(output, safeKey, { value: boundedValue(value[key], state, depth + 1), enumerable: true, configurable: true, writable: true });
    state.remaining -= 3;
    count++;
    return true;
  };
  if (depth === 0) for (const key of ['status', 'error', 'reportFile', 'saved']) if (Object.hasOwn(value, key)) add(key);
  for (const key in value) {
    if (!Object.hasOwn(value, key) || (depth === 0 && ['status', 'error', 'reportFile', 'saved'].includes(key))) continue;
    if (!add(key)) break;
  }
  state.remaining -= 2;
  return output;
}

export function boundToolResult(result) {
  const state = { remaining: MAX_TOOL_RESULT_CHARS - 512, seen: new WeakSet(), truncated: false };
  let value = boundedValue(result, state);
  if (state.truncated && value && typeof value === 'object' && !Array.isArray(value)) value.truncated = true;
  let text = JSON.stringify(value);
  if (text.length > MAX_TOOL_RESULT_CHARS) {
    value = {
      status: typeof result?.status === 'string' ? result.status.slice(0, 80) : 'fail',
      error: '工具结果已截断；请查看证据文件。',
      ...(typeof result?.reportFile === 'string' ? { reportFile: result.reportFile.slice(0, 1000) } : {}),
      ...(typeof result?.saved === 'string' ? { saved: result.saved.slice(0, 1000) } : {}),
      truncated: true,
    };
    text = JSON.stringify(value);
  }
  return { value, text };
}

export { MAX_TOOL_RESULT_CHARS };
