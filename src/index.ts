/**
 * pi-todo-list — A pi extension that replicates GitHub Copilot's manage_todo_list.
 *
 * Provides:
 * - A single `manage_todo_list` tool with read/write operations
 * - A read-only widget showing todo progress
 * - /todos command to toggle widget
 * - /todos clear command to clear the list
 * - Session persistence via tool result details
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { TodoStateManager } from "./state-manager.js";
import { createManageTodoListTool } from "./tool.js";
import { updateWidget, clearWidget } from "./ui/todo-widget.js";

export default function (pi: ExtensionAPI) {
  /**
   * One todo list per session, never one per extension.
   *
   * A host may load an extension once and share that single instance
   * across many concurrent sessions — pi's own ResourceLoader hands the
   * same loaded extension to every session it creates, so a host running
   * several agents in one process (pirouette, for one) gets exactly that.
   * A single `TodoStateManager` in this closure is then shared by every
   * agent on the box: one agent's `write` replaces another's list, a
   * `read` returns whatever agent wrote last, and the widget gets pushed
   * to whichever session happened to start a turn most recently — so one
   * chat's todo list appears above a different chat's editor.
   *
   * Keying on the session id keeps each conversation's list to itself. In
   * a one-session-per-process host (the pi CLI) the map simply holds one
   * entry and behaves exactly as before.
   */
  const states = new Map<string, TodoStateManager>();

  /** Stable per-session key. Falls back to the session file, then to a
   *  single shared slot, so an unusual host degrades to the old behaviour
   *  rather than throwing. */
  const sessionKey = (ctx: ExtensionContext): string => {
    const sm = ctx.sessionManager as {
      getSessionId?: () => string | undefined;
      getSessionFile?: () => string | undefined;
    };
    return sm?.getSessionId?.() ?? sm?.getSessionFile?.() ?? "default";
  };

  const stateFor = (ctx: ExtensionContext): TodoStateManager => {
    const key = sessionKey(ctx);
    let state = states.get(key);
    if (!state) {
      state = new TodoStateManager();
      states.set(key, state);
    }
    return state;
  };

  /** Callback invoked after every write — updates that session's widget */
  const onTodoUpdate = (ctx: ExtensionContext) => {
    updateWidget(stateFor(ctx), ctx);
  };

  // --- Reconstruct state from session on load/switch/fork/tree ---

  const reconstructState = (ctx: ExtensionContext) => {
    const state = stateFor(ctx);
    state.loadFromSession(ctx);
    updateWidget(state, ctx);
  };

  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_switch", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_fork", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

  // Update widget after each turn (in case tool was called)
  pi.on("turn_end", async (_event, ctx) => {
    updateWidget(stateFor(ctx), ctx);
  });

  // --- Register the manage_todo_list tool ---

  const tool = createManageTodoListTool(stateFor, onTodoUpdate);
  pi.registerTool(tool);

  // --- Register commands ---

  pi.registerCommand("todos", {
    description: "Toggle todo list widget or clear todos (/todos clear)",
    handler: async (args, ctx) => {
      const state = stateFor(ctx);

      if (args?.trim().toLowerCase() === "clear") {
        state.clear();
        clearWidget(ctx);
        ctx.ui.notify("Todo list cleared.", "info");
        return;
      }

      // Toggle: if todos exist, update widget; if empty, notify
      const todos = state.read();
      if (todos.length === 0) {
        ctx.ui.notify("No todos. The LLM will create them when working on complex tasks.", "info");
      } else {
        updateWidget(state, ctx);
        ctx.ui.notify(`${state.getStats().completed}/${state.getStats().total} todos completed.`, "info");
      }
    },
  });
}
