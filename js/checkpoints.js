/* ═══════════════════════════════════════════════════════════════════════════
   Checkpoints — the undo stack behind `/undo` and `/redo`.

   A checkpoint is the whole harness state at one instant: the conversation as
   the model will see it, plus every workspace file. Both halves have to move
   together — rewinding the transcript while leaving half-written files behind
   would give the model a memory that no longer matches the disk.

   This is a dumb stack. It does not know how to read or apply a state; it only
   holds them in order. js/agent.js owns `capture()` / `apply()` because it owns
   the conversation.

   Deliberately in memory only. A snapshot of the workspace per turn would
   evict the workspace itself from a 5 MB localStorage quota, so the stack is
   scoped to this page's lifetime and says so.
   ═══════════════════════════════════════════════════════════════════════════ */
window.Checkpoints = (function () {
  const LIMIT = 25;

  let past = [];    // oldest → newest; the newest is what `/undo` restores
  let future = [];  // states `/undo` moved out of the way, newest first

  /** Label a checkpoint with the thing that is about to change it. */
  function label(text) {
    const one = String(text || "").replace(/\s+/g, " ").trim();
    return one.length > 60 ? one.slice(0, 57) + "…" : one || "(unlabelled)";
  }

  return {
    /**
     * Record the state as it is *now*, before whatever is about to change it.
     * A new branch of history invalidates anything `/undo` had set aside.
     */
    mark(state, text) {
      past.push({ ...state, label: label(text), at: Date.now() });
      if (past.length > LIMIT) past.shift();
      future = [];
    },

    /** Newest checkpoint, with `current` set aside so redo can return to it. */
    undo(current) {
      if (!past.length) return null;
      const target = past.pop();
      future.unshift({ ...current, label: target.label, at: Date.now() });
      return target;
    },

    /** Undo the undo. Returns the state `/undo` moved out of the way. */
    redo(current) {
      if (!future.length) return null;
      const target = future.shift();
      past.push({ ...current, label: target.label, at: Date.now() });
      return target;
    },

    /** What `/undo` would step back past, for the message it prints. */
    peek() { return past.length ? past[past.length - 1] : null; },

    get depth() { return past.length; },
    get redoDepth() { return future.length; },

    clear() { past = []; future = []; },
  };
})();
