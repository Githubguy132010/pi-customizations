import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HIDDEN_COMMANDS = new Set([
  "name",
  "tree",
  "fork",
  "clone",
  "compact",
  "trust",
  "export",
  "import",
  "share",
  "hotkeys",
  "changelog",
  "llama",
]);

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: current.triggerCharacters,

      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const suggestions = await current.getSuggestions(lines, cursorLine, cursorCol, options);
        if (!suggestions?.prefix.startsWith("/")) {
          return suggestions;
        }

        const items = suggestions.items.filter((item) => !HIDDEN_COMMANDS.has(item.value));
        return items.length > 0 ? { ...suggestions, items } : null;
      },

      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      },

      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
      },
    }));
  });
}
