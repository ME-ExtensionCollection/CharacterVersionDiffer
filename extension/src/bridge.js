// Char Differ: finds Marinara's UI store and query client.
//
// Marinara does not publish them to page code. Same lookup as Character
// Library's bridge (ME-Extensions/CharacterLib/extension/src/bridge.js):
//   1. globalThis.__MARINARA_HOST__ (present when a capability package loaded)
//   2. React's fiber tree: zustand's useStore keeps [store, selector] as
//      useCallback dependencies, so any mounted component that reads the UI
//      store leads to it. The QueryClientProvider's `client` prop is found in
//      the same walk.
// The UI store gives the open character (characterDetailId) and whether the
// editor has unsaved edits (editorDirty). The query client refreshes the
// editor and its version list after a save.

const CDBridge = (() => {
  "use strict";

  const MAX_FIBERS = 300000;
  let cached = { ui: null, queryClient: null };

  const isUiStore = (api) => {
    try {
      if (!api || typeof api.getState !== "function" || typeof api.subscribe !== "function") return false;
      const state = api.getState();
      return !!state && "characterDetailId" in state && typeof state.openCharacterDetail === "function";
    } catch {
      return false;
    }
  };
  const isQueryClient = (client) =>
    !!client && typeof client.invalidateQueries === "function" && typeof client.getQueryCache === "function";

  function reactRootFiber() {
    const candidates = [document.getElementById("root"), ...document.body.children];
    for (const node of candidates) {
      if (!node) continue;
      const key = Object.keys(node).find((k) => k.startsWith("__reactContainer$"));
      if (key && node[key]) return node[key];
    }
    return null;
  }

  function scanFibers() {
    const found = { ui: null, queryClient: null };
    const root = reactRootFiber();
    if (!root) return found;
    const stack = [root];
    let seen = 0;
    while (stack.length && seen < MAX_FIBERS && !(found.ui && found.queryClient)) {
      const fiber = stack.pop();
      seen += 1;
      if (!found.queryClient && isQueryClient(fiber.memoizedProps?.client)) found.queryClient = fiber.memoizedProps.client;
      if (!found.ui && typeof fiber.type !== "string") {
        let hook = fiber.memoizedState;
        let guard = 0;
        while (hook && typeof hook === "object" && "next" in hook && guard < 200) {
          const value = hook.memoizedState;
          const store = Array.isArray(value) && Array.isArray(value[1]) ? value[1].find(isUiStore) : null;
          if (store) {
            found.ui = store;
            break;
          }
          hook = hook.next;
          guard += 1;
        }
      }
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
    }
    return found;
  }

  function host() {
    const published = globalThis.__MARINARA_HOST__;
    if (!isUiStore(cached.ui) && isUiStore(published?.stores?.ui)) cached.ui = published.stores.ui;
    if (!isQueryClient(cached.queryClient) && isQueryClient(published?.queryClient)) cached.queryClient = published.queryClient;
    if (!isUiStore(cached.ui) || !isQueryClient(cached.queryClient)) {
      try {
        const found = scanFibers();
        if (!isUiStore(cached.ui)) cached.ui = found.ui;
        if (!isQueryClient(cached.queryClient)) cached.queryClient = found.queryClient;
      } catch (error) {
        marinara.log.debug("Char Differ could not inspect Marinara's component tree", error);
      }
    }
    return cached;
  }

  /** { characterId, personaOpen, dirty } from the UI store, or null if it can't be found. */
  function editorState() {
    const { ui } = host();
    if (!ui) return null;
    const state = ui.getState();
    return {
      characterId: typeof state.characterDetailId === "string" ? state.characterDetailId : null,
      personaOpen: typeof state.personaDetailId === "string" && !!state.personaDetailId,
      dirty: state.editorDirty === true,
    };
  }

  /**
   * Refetch the character and its versions, so the editor shows the saved card
   * (characterKeys in packages/client/src/hooks/use-characters.ts).
   */
  function refreshCharacter(id) {
    const { queryClient } = host();
    if (!queryClient) return false;
    try {
      void queryClient.invalidateQueries({ queryKey: ["characters", "detail", id] });
      void queryClient.invalidateQueries({ queryKey: ["characters", "list"] });
      void queryClient.invalidateQueries({ queryKey: ["characters", "summaries"] });
      return true;
    } catch (error) {
      marinara.log.debug("Char Differ could not refresh Marinara's character data", error);
      return false;
    }
  }

  marinara.onCleanup(() => {
    cached = { ui: null, queryClient: null };
  });

  return Object.freeze({ editorState, refreshCharacter });
})();
