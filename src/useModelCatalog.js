import { useCallback } from "react";
import { useNativeCatalog } from "./useNativeCatalog";

export function useModelCatalog(account, invoke, { refreshOnEntry = false } = {}) {
  const accountId = account?.id;
  const ready = account?.status === "ready";
  const binding = JSON.stringify([
    accountId, account?.provider, account?.identity, account?.status, account?.bin,
    account?.source, account?.plan, account?.bindingRevision,
    account?.provider === "antigravity" ? account.model : null,
  ]);
  const query = useCallback(force =>
    invoke("botOptions", force ? { accountId, refresh: true } : { accountId }),
  [accountId, invoke]);
  const read = useNativeCatalog({ id: accountId, binding, enabled: ready, query, refreshOnEntry });
  if (!ready) {
    const reason = account?.reason || (account ? "请先核实此账号的原生登录。" : "请先选择绑定账号。");
    return { catalog: { models: [], reason }, loading: false };
  }
  return {
    catalog: read.error ? { ...read.data, reason: read.error } : read.data,
    loading: read.pending && !read.data?.models?.length,
    refresh: read.retry,
  };
}
