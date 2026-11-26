import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./ui";

// Remember reads for this editor visit. Retain the last verified catalog within the same
// workspace/chat scope while a setting change refreshes in the background.
const latestByScope = new Map();

export function useNativeCatalog({ id, binding, fallbackKey = binding, enabled, query, refreshOnEntry }) {
  const [reads, setReads] = useState({});
  const requests = useRef(new Map());
  const load = useCallback(async (force = false) => {
    if (!enabled) return;
    const last = requests.current.get(id);
    if (last?.binding === binding && (!force || last.pending)) return;
    const request = { binding, pending: true };
    requests.current.set(id, request);
    function publish(data, error) {
      if (requests.current.get(id) !== request) return;
      if (data && fallbackKey) {
        if (latestByScope.size >= 64) {
          latestByScope.delete(latestByScope.keys().next().value);
        }
        latestByScope.set(fallbackKey, data);
      }
      const pending = request.pending;
      setReads(previous => {
        const before = previous[id];
        const current = data ?? (before?.binding === binding ? before.data : null);
        return { ...previous, [id]: { binding, data: current, pending, error } };
      });
    }
    publish();
    try {
      let data = await query(force);
      if (!force && refreshOnEntry && data.cached && requests.current.get(id) === request) {
        publish(data);
        data = await query(true);
      }
      request.pending = false;
      publish(data);
    } catch (error) {
      request.pending = false;
      publish(null, errorText(error));
    }
  }, [id, binding, fallbackKey, enabled, query, refreshOnEntry]);

  useEffect(() => {
    if (enabled) load();
    else if (requests.current.delete(id)) {
      setReads(previous => {
        const next = { ...previous };
        delete next[id];
        return next;
      });
    }
  }, [load, enabled, id]);
  useEffect(() => () => requests.current.clear(), []);

  const read = enabled && reads[id]?.binding === binding ? reads[id] : null;
  const isPending = enabled && (read?.pending ?? true);
  const fallbackData =
    isPending && !read?.error && fallbackKey ? latestByScope.get(fallbackKey) || null : null;
  return {
    data: read?.data ?? fallbackData,
    pending: isPending,
    error: read?.error,
    retry: enabled ? () => load(true) : undefined,
  };
}
