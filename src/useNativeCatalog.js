import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./ui";

// Remember reads for this editor visit. The main process owns the cross-visit cache.
export function useNativeCatalog({ id, binding, enabled, query, refreshOnEntry }) {
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
  }, [id, binding, enabled, query, refreshOnEntry]);

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
  return {
    data: read?.data,
    pending: enabled && (read?.pending ?? true),
    error: read?.error,
    retry: enabled ? () => load(true) : undefined,
  };
}
