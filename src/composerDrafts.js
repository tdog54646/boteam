export const composerDraftStorageKey = "boteam:composer-inputs";

const maxStoredDrafts = 200;
const maxDraftTextLength = 200_000;

function isNonEmptyObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = typeof raw.text === "string" ? raw.text.slice(0, maxDraftTextLength) : "";
  const selected = Array.isArray(raw.selected)
    ? raw.selected.filter((id) => typeof id === "string" && id.length > 0).slice(0, 64)
    : [];
  const extensions =
    raw.extensions && typeof raw.extensions === "object" && !Array.isArray(raw.extensions)
      ? Object.fromEntries(
          Object.entries(raw.extensions)
            .filter(([, list]) => Array.isArray(list) && list.length > 0)
            .map(([botId, list]) => [
              botId,
              list.filter((item) => item && typeof item.id === "string" && typeof item.label === "string").slice(0, 32),
            ])
            .filter(([, list]) => list.length > 0),
        )
      : {};
  const slashMember = typeof raw.slashMember === "string" && raw.slashMember ? raw.slashMember : undefined;
  const replyToMessageId =
    typeof raw.replyToMessageId === "string" && raw.replyToMessageId ? raw.replyToMessageId : null;
  const settingsByBot =
    raw.settingsByBot && typeof raw.settingsByBot === "object" && !Array.isArray(raw.settingsByBot)
      ? raw.settingsByBot
      : {};
  const pausedGoals =
    raw.pausedGoals && typeof raw.pausedGoals === "object" && !Array.isArray(raw.pausedGoals)
      ? raw.pausedGoals
      : {};
  const hasAttachments = Boolean(raw.hasAttachments);

  if (
    !text &&
    !selected.length &&
    !isNonEmptyObject(extensions) &&
    !replyToMessageId &&
    !isNonEmptyObject(settingsByBot) &&
    !isNonEmptyObject(pausedGoals) &&
    !hasAttachments
  ) {
    return null;
  }
  return {
    text,
    selected,
    extensions,
    ...(slashMember && { slashMember }),
    replyToMessageId,
    settingsByBot,
    pausedGoals,
    ...(hasAttachments && { hasAttachments: true }),
  };
}

function loadFromStorage() {
  const map = new Map();
  try {
    const raw = localStorage.getItem(composerDraftStorageKey);
    if (!raw) return map;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return map;
    for (const [scope, entry] of Object.entries(parsed)) {
      if (typeof scope !== "string" || !scope) continue;
      const clean = sanitizeEntry(entry);
      if (clean) map.set(scope, clean);
    }
  } catch {}
  return map;
}

let cache = loadFromStorage();
const subscribers = new Map();

function persistToStorage() {
  while (cache.size > maxStoredDrafts) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  try {
    if (!cache.size) localStorage.removeItem(composerDraftStorageKey);
    else localStorage.setItem(composerDraftStorageKey, JSON.stringify(Object.fromEntries(cache)));
  } catch {}
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.storageArea !== localStorage) return;
    if (event.key !== null && event.key !== composerDraftStorageKey) return;
    const previous = cache;
    cache = loadFromStorage();
    for (const [scope, listeners] of subscribers.entries()) {
      const beforeJson = JSON.stringify(previous.get(scope) || null);
      const afterValue = cache.get(scope) || null;
      if (beforeJson !== JSON.stringify(afterValue)) {
        for (const fn of listeners) fn(afterValue);
      }
    }
  });
}

export function getComposerDraft(scope) {
  return scope ? cache.get(scope) : undefined;
}

export function hasComposerDraft(scope) {
  return Boolean(scope && cache.has(scope));
}

export function setComposerDraft(scope, value) {
  if (!scope) return;
  const clean = sanitizeEntry(value);
  const prevJson = JSON.stringify(cache.get(scope) || null);
  const nextJson = JSON.stringify(clean);
  if (prevJson === nextJson) return;
  cache.delete(scope);
  if (clean) cache.set(scope, clean);
  persistToStorage();
}

export function deleteComposerDraft(scope) {
  if (!scope || !cache.has(scope)) return;
  cache.delete(scope);
  persistToStorage();
}

export function pruneComposerDrafts(validChatIds, validDraftKeys) {
  let changed = false;
  for (const scope of [...cache.keys()]) {
    if (scope.startsWith("home:")) continue;
    if (scope.startsWith("draft:")) {
      if (!validDraftKeys.has(scope)) {
        cache.delete(scope);
        changed = true;
      }
      continue;
    }
    if (!validChatIds.has(scope)) {
      cache.delete(scope);
      changed = true;
    }
  }
  if (changed) persistToStorage();
}

export function subscribeComposerDraft(scope, listener) {
  if (!scope || typeof listener !== "function") return () => {};
  let set = subscribers.get(scope);
  if (!set) {
    set = new Set();
    subscribers.set(scope, set);
  }
  set.add(listener);
  return () => {
    const current = subscribers.get(scope);
    if (!current) return;
    current.delete(listener);
    if (!current.size) subscribers.delete(scope);
  };
}
