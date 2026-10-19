// Bounded undo/redo history. Consecutive pushes with the same coalesce key (e.g. one drag) merge into one step.

export function createHistory(present, { limit = 100 } = {}) {
  return { past: [], present, future: [], limit, lastKey: null };
}

export function push(history, next, { coalesce = null } = {}) {
  if (next === history.present) return history;
  if (coalesce && coalesce === history.lastKey && history.past.length) {
    return { ...history, present: next, future: [] };
  }
  const past = [...history.past, history.present].slice(-history.limit);
  return { ...history, past, present: next, future: [], lastKey: coalesce };
}

export function undo(history) {
  if (!history.past.length) return history;
  const past = history.past.slice(0, -1);
  return { ...history, past, present: history.past[history.past.length - 1], future: [history.present, ...history.future], lastKey: null };
}

export function redo(history) {
  if (!history.future.length) return history;
  const [next, ...future] = history.future;
  return { ...history, past: [...history.past, history.present], present: next, future, lastKey: null };
}

export function endCoalesce(history) {
  return history.lastKey === null ? history : { ...history, lastKey: null };
}

export const canUndo = (h) => h.past.length > 0;
export const canRedo = (h) => h.future.length > 0;
