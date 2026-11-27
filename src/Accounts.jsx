import { useLanguage } from "./preferences";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  FolderOpen,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
} from "lucide-react";
import {
  accountLabel,
  Button,
  errorText,
  Field,
  IconButton,
  identityLabel,
  Modal,
  needsAntigravityBinding,
  Notice,
  ProviderIcon,
  providerName,
  providers,
  Select,
  Spinner,
  Status,
} from "./ui";
import "./settings.css";

function loginLabel(account, tr) {
  if (account.loginState === "signed-in") return tr("已登录", "Signed in");
  if (
    account.loginState === "signed-out" ||
    (account.status === "login" && !account.loginState)
  )
    return tr("未登录", "Signed out");
  if (!account.loginState && account.status === "ready") return tr("已登录", "Signed in");
  return tr("登录状态待核实", "Sign-in unverified");
}
function installLabel(account, tr) {
  if (account.cliInstalled ?? Boolean(account.bin))
    return account.appInstalled ? tr("已安装 CLI 和桌面端", "CLI and desktop app installed") : tr("已安装 CLI", "CLI installed");
  return account.appInstalled ? tr("已安装桌面端", "Desktop app installed") : tr("未检测到 CLI", "CLI not detected");
}
function needsGoogleGrant(candidate) {
  return candidate.provider === "antigravity" && !candidate.importedId &&
    !candidate.canReuseBinding && candidate.requiresAuthorization !== false &&
    candidate.status !== "ready" && candidate.status !== "missing";
}
function canImport(candidate) {
  if (!candidate.candidateId) return false;
  if (candidate.importedId || candidate.canReuseBinding) return true;
  if (candidate.provider === "antigravity")
    return Boolean(candidate.identity && candidate.status === "ready") ||
      Boolean(needsGoogleGrant(candidate) && candidate.bin && candidate.email);
  return Boolean(candidate.identity && ["ready", "blocked"].includes(candidate.status));
}
function initiallySelected(candidate) {
  return canImport(candidate) && (candidate.status === "ready" || candidate.canReuseBinding);
}

function DetailList({ rows }) {
  return (
    <dl className="account-details">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <React.Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </React.Fragment>
        ))}
    </dl>
  );
}

function technicalDetails(account, tr) {
  return [
    [account.configFound === false ? tr("检测位置", "Scan location") : tr("配置目录", "Configuration directory"), account.source],
    [
      tr("发现来源", "Found in"),
      account.origin !== account.source && account.origin,
    ],
    [tr("执行程序", "Executable"), account.bin],
    [tr("安装状态", "Installation"), installLabel(account, tr)],
    [tr("登录状态", "Sign-in"), loginLabel(account, tr)],
    [tr("默认模型", "Default model"), account.model],
    [tr("工作目录", "Working directory"), account.cwd],
  ];
}

function discoveryIdentity(account, tr) {
  if (account.email && account.identity?.startsWith("source:"))
    return tr(`上次登录 · ${account.email}`, `Last sign-in · ${account.email}`);
  return identityLabel(account);
}

function Candidate({
  candidate,
  selected,
  toggle,
  disabled,
  onLogin,
  onInstall,
  onInstallGuide,
  onRescan,
  onCancel,
  authorizing,
  installing,
  authError,
}) {
  const tr = useLanguage();
  const [expanded, setExpanded] = useState(false);
  const { provider, identity, status, reason, plan } = candidate;
  const eligible = canImport(candidate);
  const source = candidate.configFound === false ? "" : candidate.source || "";
  const shortSource = source.replace(/^\/Users\/[^/]+(?=\/)/, "~");
  const needsLogin = needsGoogleGrant(candidate);
  const missingCli = provider === "antigravity" && !candidate.bin && (candidate.appInstalled || candidate.configFound);
  const rescanFailedImport = authError && !missingCli && !needsLogin && !candidate.canReuseBinding;
  const canResume = authError?.includes("已保留本次 Google 授权");
  const loginAction = canResume
    ? tr("继续 Google 授权设置", "Continue Google authorization")
    : candidate.existingAccountId
      ? tr("重新授权并导入", "Reauthorize and import")
      : tr("Google 授权并导入", "Authorize with Google and import");
  const summary =
    identity || candidate.email
      ? [discoveryIdentity(candidate, tr), plan].filter(Boolean).join(" · ")
      : status === "missing"
        ? installLabel(candidate, tr)
        : loginLabel(candidate, tr);
  return (
    <div className="detected-account">
      <div className="candidate-line">
        <label
          className={`candidate ${selected ? "picked" : ""} ${eligible ? "eligible" : ""}`}
        >
          <input
            type="checkbox"
            checked={selected}
            disabled={disabled || !eligible}
            onChange={toggle}
            aria-label={tr(`选择 ${providerName(provider)} ${discoveryIdentity(candidate, tr)}`, `Select ${providerName(provider)} ${discoveryIdentity(candidate, tr)}`)}
          />
          <span
            className={`custom-check ${selected ? "checked" : ""}`}
            aria-hidden="true"
          >
            {selected && <Check size={12} />}
          </span>
          <ProviderIcon provider={provider} />
          <span className="candidate-copy">
            <span className="candidate-name">
              <strong>{providerName(provider)}</strong>
              {shortSource && <code title={source}>{shortSource}</code>}
            </span>
            <small title={summary}>
              {summary}
              {status !== "missing" &&
                summary !== loginLabel(candidate, tr) &&
                " · " + loginLabel(candidate, tr)}
            </small>
          </span>
          <Status
            status={candidate.canReuseBinding ? "ready" : status}
            label={
              missingCli ? tr("需要安装 CLI", "CLI installation required") :
                candidate.canReuseBinding ? tr("可导入", "Ready to import") :
                needsLogin ? (candidate.existingAccountId ? tr("需重新授权", "Reauthorization required") : tr("需要授权", "Authorization required")) :
                undefined
            }
          />
        </label>
        <IconButton
          icon={ChevronDown}
          className="account-disclosure"
          aria-expanded={expanded}
          label={tr(`${expanded ? "收起" : "查看"} ${providerName(provider)} 配置详情`, `${expanded ? "Hide" : "Show"} ${providerName(provider)} configuration details`)}
          onClick={() => setExpanded((open) => !open)}
        />
      </div>
      {(missingCli || needsLogin || (provider === "antigravity" && authError)) && (
        <div className="candidate-auth">
          <p>
            {authorizing
              ? tr("正在等待 Google 授权和原生账号核验…", "Waiting for Google authorization and account verification…")
              : installing
                ? tr("正在安装官方 agy…", "Installing the official agy CLI…")
                : missingCli
                ? (candidate.sourceKind === "cli"
                    ? tr("安装后会核验此 CLI 配置的登录状态。", "After installation, BoTeam will check whether this CLI is signed in.")
                    : tr("安装官方 agy 后，可通过 Google 授权绑定此订阅。", "Install the official agy CLI to link this subscription with Google."))
                : rescanFailedImport
                  ? tr("重新检测此原生配置后可再次导入。", "Scan this configuration again before importing.")
                : candidate.email
                  ? tr(`Google 授权时请选择 ${candidate.email}。`, `Choose ${candidate.email} when signing in with Google.`)
                  : tr("通过 agy 的官方 Google 登录，绑定要导入的订阅账号。", "Sign in with Google through agy to link the subscription you want to import.")}
          </p>
          {authError && <Notice>{authError}</Notice>}
          <div>
            {authorizing ? (
              <Button onClick={onCancel}>{tr("取消授权", "Cancel authorization")}</Button>
            ) : missingCli ? (
              <Button
                disabled={disabled}
                busy={installing}
                icon={Download}
                onClick={onInstall}
              >
                {tr("安装官方 agy", "Install agy")}
              </Button>
            ) : rescanFailedImport ? (
              <Button disabled={disabled} icon={RefreshCw} onClick={onRescan}>{tr("重新检测此来源", "Scan this source again")}</Button>
            ) : (
              <Button
                disabled={disabled}
                icon={KeyRound}
                onClick={() => onLogin(false)}
              >
                {loginAction}
              </Button>
            )}
            {missingCli && authError && (
              <button className="text-btn" onClick={onInstallGuide}>
                {tr("官方安装说明", "Official installation guide")}
              </button>
            )}
            {canResume && !authorizing && (
              <button
                className="text-btn"
                disabled={disabled}
                onClick={() => onLogin(true)}
              >
                {tr("重新选择 Google 账号", "Choose another Google account")}
              </button>
            )}
          </div>
        </div>
      )}
      {expanded && (
        <div className="candidate-details">
          <DetailList
            rows={[...technicalDetails(candidate, tr),
              [tr("来源类型", "Source type"), candidate.sourceKind === "cli" ? tr("原生 CLI", "Native CLI") : candidate.sourceKind === "desktop" ? tr("桌面客户端", "Desktop app") : null],
              [tr("检测说明", "Scan details"), reason]]}
          />
        </div>
      )}
    </div>
  );
}
export function Discovery({
  invoke,
  onFinish,
  onSkip,
  onboarding = false,
  pending = false,
}) {
  const tr = useLanguage();
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState([]);
  const [working, setWorking] = useState("scan");
  const [error, setError] = useState("");
  const [sourceOpen, setSourceOpen] = useState(false);
  const [scanProvider, setScanProvider] = useState("codex");
  const [authError, setAuthError] = useState(null);
  const activeLogin = useRef(null);
  const manualSources = useRef(new Map());
  const mounted = useRef(false);
  useEffect(() => {
    let live = true;
    mounted.current = true;
    invoke("detect")
      .then((result) => {
        if (live) {
          setItems(result);
          setSelected(
            result
              .filter(initiallySelected)
              .map((x) => x.candidateId),
          );
        }
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      })
      .finally(() => {
        if (live) setWorking("");
      });
    return () => {
      live = false;
      mounted.current = false;
      if (activeLogin.current) {
        invoke("cancelLogin", { requestId: activeLogin.current }).catch(
          () => {},
        );
        activeLogin.current = null;
      }
    };
  }, [invoke]);
  async function scan(custom = false, knownSources) {
    setWorking("scan");
    setError("");
    try {
      let requests = knownSources || [{}, ...manualSources.current.values()];
      if (custom) {
        const source = await invoke("pickDirectory");
        if (!source) return;
        requests = [{ provider: scanProvider, source }];
      }
      const key = item => JSON.stringify([item.provider, item.source]);
      const results = await Promise.allSettled(requests.map(request => invoke("detect", request)));
      if (!mounted.current) return;
      const rows = new Map((custom || knownSources ? items : []).map(item => [key(item), item]));
      const failures = [];
      for (const [i, result] of results.entries()) {
        const request = requests[i];
        if (request.source) rows.delete(key(request));
        if (result.status === "rejected") {
          failures.push([request.source, errorText(result.reason)].filter(Boolean).join(" · "));
          continue;
        }
        if (custom) manualSources.current.set(key(request), request);
        for (const item of result.value) rows.set(key(item), item);
      }
      const next = [...rows.values()];
      setItems(next);
      setSelected(
        next
          .filter((item) => {
            if (!canImport(item)) return false;
            const previous = items.find(
              (old) =>
                old.provider === item.provider &&
                (old.candidateId === item.candidateId ||
                  (old.source === item.source &&
                    old.identity === item.identity)),
            );
            return previous && canImport(previous)
              ? selected.includes(previous.candidateId)
              : initiallySelected(item);
          })
          .map((item) => item.candidateId),
      );
      if (failures.length) setError(failures.join("\n"));
      setSourceOpen(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking("");
    }
  }
  async function installCli(candidate) {
    if (working) return;
    setWorking("install-" + candidate.candidateId);
    setError("");
    setAuthError(null);
    try {
      await invoke("installAntigravityCli");
      if (mounted.current) await scan(false, items
        .filter(row => row.provider === "antigravity")
        .map(({provider, source}) => ({provider, source})));
    } catch (e) {
      if (mounted.current) setAuthError({candidateId:candidate.candidateId,message:errorText(e)});
    } finally {
      if (mounted.current) setWorking("");
    }
  }
  async function loginCandidate(candidate, fresh) {
    const requestId = crypto.randomUUID();
    activeLogin.current = requestId;
    setWorking(candidate.candidateId);
    setAuthError(null);
    setError("");
    try {
      const id = await invoke("login", {
        provider: "antigravity",
        candidateId: candidate.candidateId,
        requestId,
        fresh,
      });
      if (!mounted.current) return id;
      // Authorization proves the isolated account. Keep each external source's
      // own path and login evidence on its discovery row.
      setItems((rows) =>
        rows.map((row) =>
          row.candidateId === candidate.candidateId
            ? { ...row, canReuseBinding: true, existingAccountId: id, importedId: id }
            : row,
        ),
      );
      setSelected((chosen) => [...new Set([...chosen, candidate.candidateId])]);
      return id;
    } catch (e) {
      if (mounted.current)
        setAuthError({
          candidateId: candidate.candidateId,
          message: errorText(e),
        });
      throw e;
    } finally {
      if (activeLogin.current === requestId) activeLogin.current = null;
    }
  }
  async function authorize(candidate, fresh) {
    if (working || activeLogin.current) return;
    try { await loginCandidate(candidate, fresh); }
    catch { /* loginCandidate displays the native error on the selected row. */ }
    finally { if (mounted.current) setWorking(""); }
  }
  async function cancelLogin() {
    const requestId = activeLogin.current;
    if (!requestId) return;
    try {
      await invoke("cancelLogin", { requestId });
    } catch (e) {
      if (mounted.current && activeLogin.current === requestId)
        setError(errorText(e));
    }
  }
  async function doImport() {
    setWorking("import");
    setError("");
    try {
      const ids = [],
        failures = [];
      const chosen = items.filter((item) => selected.includes(item.candidateId))
        .sort((a, b) => Number(needsGoogleGrant(a)) - Number(needsGoogleGrant(b)));
      const googleAccounts = new Map(chosen.filter(item => item.provider === "antigravity" && item.email && item.importedId)
        .map(item => [item.email.toLowerCase(), item.importedId]));
      for (const item of chosen) {
        if (!mounted.current) return;
        try {
          const email = item.provider === "antigravity" && item.email?.toLowerCase();
          const id = item.importedId || (email && googleAccounts.get(email)) ||
            (needsGoogleGrant(item)
              ? await loginCandidate(item, false)
              : (await invoke("import", { candidateIds: [item.candidateId] }))[0]);
          if (!mounted.current) return;
          if (email) googleAccounts.set(email, id);
          setWorking("import");
          ids.push(id);
          if (!item.importedId && mounted.current)
            setItems((rows) =>
              rows.map((row) =>
                row.candidateId === item.candidateId
                  ? { ...row, existingAccountId: id, importedId: id }
                  : row,
              ),
            );
        } catch (e) {
          if (!mounted.current) return;
          if (item.provider === "antigravity" && !needsGoogleGrant(item))
            setAuthError({candidateId:item.candidateId,message:errorText(e)});
          failures.push(providerName(item.provider) + " · " + errorText(e));
        }
      }
      if (!mounted.current) return;
      if (failures.length) {
        setError(
          (ids.length ? tr(`${ids.length} 个账号导入成功。`, `Accounts imported: ${ids.length}.`) : "") +
            failures.join(" "),
        );
      } else if (ids.length) await onFinish([...new Set(ids)]);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking("");
    }
  }
  return (
    <div className="account-discovery">
      <div className="discovery-toolbar">
        <h3>{tr("本机配置", "Local configurations")}</h3>
        <button
          className="text-btn"
          onClick={() => scan()}
          disabled={!!working || pending}
        >
          <RefreshCw size={13} className={working === "scan" ? "spin" : ""} />
          {tr("重新检测", "Scan again")}
        </button>
      </div>
      <div className="candidates" aria-busy={working === "scan"}>
        {items.length ? (
          items.map((item, index) => (
            <Candidate
              key={item.candidateId || index}
              candidate={item}
              selected={selected.includes(item.candidateId)}
              disabled={!!working || pending}
              authorizing={working === item.candidateId}
              installing={working === "install-" + item.candidateId}
              authError={
                authError?.candidateId === item.candidateId
                  ? authError.message
                  : ""
              }
              onLogin={(fresh) => authorize(item, fresh)}
              onCancel={cancelLogin}
              onInstall={() => installCli(item)}
              onRescan={() => scan(false, [{provider: item.provider, source: item.source}])}
              onInstallGuide={() =>
                invoke("openAntigravityInstall").catch((e) =>
                  setError(errorText(e)),
                )
              }
              toggle={() =>
                setSelected((s) =>
                  s.includes(item.candidateId)
                    ? s.filter((id) => id !== item.candidateId)
                    : [...s, item.candidateId],
                )
              }
            />
          ))
        ) : working === "scan" ? (
          Object.keys(providers).map((p) => (
            <div className="candidate pending" key={p}>
              <ProviderIcon provider={p} />
              <div className="row-copy">
                <strong>{providerName(p)}</strong>
                <small>{tr("正在检测本机配置…", "Scanning local configurations…")}</small>
              </div>
              <Spinner />
            </div>
          ))
        ) : (
          <div className="inline-empty">
            <p>{tr("未发现可导入的本机配置", "No local configurations found")}</p>
            <small>{tr("选择其他配置目录，或在账号管理中添加账号。", "Choose another configuration directory or add an account in Settings.")}</small>
          </div>
        )}
      </div>
      <div className="source-disclosure">
        <button
          className="text-btn"
          onClick={() => setSourceOpen((x) => !x)}
          disabled={!!working || pending}
          aria-expanded={sourceOpen}
        >
          <FolderOpen size={15} />
          {tr("选择其他配置目录", "Choose another configuration directory")}
          <ChevronDown size={13} />
        </button>
        {sourceOpen && (
          <div className="source-picker">
            <Select
              aria-label={tr("检测工具", "Tool to scan")}
              value={scanProvider}
              onChange={(e) => setScanProvider(e.target.value)}
            >
              {Object.entries(providers).map(([key, value]) => (
                <option key={key} value={key}>
                  {value}
                </option>
              ))}
            </Select>
            <Button disabled={!!working || pending} onClick={() => scan(true)}>
              {tr("选择目录并检测", "Choose directory and scan")}
            </Button>
          </div>
        )}
      </div>
      <Notice>{error}</Notice>
      <div className={onboarding ? "setup-footer" : "form-actions"}>
        <button
          type="button"
          className="text-btn subtle"
          disabled={working === "import" || pending}
          onClick={onSkip}
        >
          {onboarding ? tr("暂时跳过", "Skip for now") : tr("取消", "Cancel")}
        </button>
        <Button
          variant="primary"
          disabled={!selected.length || !!working || pending}
          busy={working === "import"}
          onClick={doImport}
        >
          {onboarding ? tr("导入并继续", "Import and continue") : tr("导入所选账号", "Import selected accounts")}
        </Button>
      </div>
    </div>
  );
}
export function AccountList({ accounts, bots, open }) {
  const tr = useLanguage();
  const [query, setQuery] = useState("");
  const botNames = (id) =>
    bots.filter((b) => b.accountId === id && !b.archived).map((b) => b.name);
  const matches = accounts.filter((a) =>
    [
      providerName(a.provider),
      a.note,
      identityLabel(a),
      a.origin || a.source,
      a.plan,
      ...botNames(a.id),
    ].some((v) => v?.toLowerCase().includes(query.trim().toLowerCase())),
  );
  return (
    <div className="settings-page">
      <header className="settings-heading">
        <h1>{tr("账号管理", "Accounts")}</h1>
        <p>{tr("管理 Bot 使用的订阅账号。", "Manage the subscriptions your bots use.")}</p>
      </header>
      <section aria-label={tr("订阅账号", "Subscription accounts")}>
        <div className="settings-section-heading">
          <h2>{tr("订阅账号", "Subscription accounts")}</h2>
          <Button icon={Plus} onClick={() => open({ type: "login" })}>
            {tr("添加账号", "Add account")}
          </Button>
        </div>
        {accounts.length > 0 && (
          <div className="account-search">
            <Search size={15} />
            <input
              aria-label={tr("搜索账号", "Search accounts")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={tr("搜索账号、备注或绑定的 Bot", "Search accounts, notes or linked bots")}
            />
          </div>
        )}
        <div className="settings-group">
          {matches.length ? (
            matches.map((a) => (
              <div className="settings-row" key={a.id}>
                <ProviderIcon provider={a.provider} />
                <div className="row-copy">
                  <strong>{accountLabel(a)}</strong>
                  <small>
                    {[
                      providerName(a.provider),
                      a.note && identityLabel(a),
                      a.plan,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                  {botNames(a.id).length > 0 && (
                    <small>{tr("绑定 Bot ·", "Linked bots ·")} {botNames(a.id).join("、")}</small>
                  )}
                </div>
                <Status status={a.status} />
                <IconButton
                  icon={MoreHorizontal}
                  label={tr(`管理账号 ${accountLabel(a)}`, `Manage account ${accountLabel(a)}`)}
                  onClick={() => open({ type: "account", id: a.id })}
                />
              </div>
            ))
          ) : accounts.length ? (
            <div className="settings-row">
              <h3>{tr("没有匹配的账号", "No matching accounts")}</h3>
              <Button onClick={() => setQuery("")}>{tr("清除搜索", "Clear search")}</Button>
            </div>
          ) : (
            <p className="settings-empty">{tr("尚未添加订阅账号", "No subscription accounts yet")}</p>
          )}
        </div>
      </section>
    </div>
  );
}

export function LocalAccountSettings({ open }) {
  const tr = useLanguage();
  return <div className="page-scroll"><article className="settings-page">
    <header className="settings-heading"><h1>{tr("本机配置", "Local configurations")}</h1>
      <p>{tr("将本机已登录的订阅账号连接到 BoTeam。", "Connect subscription accounts already signed in on this device.")}</p>
    </header>
      <section aria-label={tr("本机配置", "Local configurations")}>
        <h2>{tr("订阅账号来源", "Subscription sources")}</h2>
        <div className="settings-group">
          <div className="settings-row">
            <div className="row-copy">
              <strong>{tr("导入本机账号", "Import local accounts")}</strong>
              <small>
                {tr("查找 Codex、Claude Code 和 Antigravity 已有的登录配置。", "Find existing sign-ins for Codex, Claude Code and Antigravity.")}
              </small>
            </div>
            <Button icon={ScanLine} onClick={() => open({ type: "import" })}>
              {tr("检测本机账号", "Scan local accounts")}
            </Button>
          </div>
        </div>
      </section>
  </article></div>;
}

export function LoginDialog({ account, invoke, onClose, onDone }) {
  const tr = useLanguage();
  const [provider, setProvider] = useState(account?.provider || "codex");
  const [phase, setPhase] = useState("idle");
  const busy = phase !== "idle";
  const [error, setError] = useState("");
  const [missingCli, setMissingCli] = useState(
    () => needsAntigravityBinding(account) && !account.bin,
  );
  const showInstallGuide = provider === "antigravity" && !busy && missingCli;
  const retainedLogin =
    provider === "antigravity" && error.includes("已保留本次 Google 授权");
  const activeLogin = useRef(null);
  const cancelOnClose = useCallback(() => {
    const attempt = activeLogin.current;
    activeLogin.current = null;
    if (attempt) invoke("cancelLogin", { requestId: attempt.id }).catch(() => {});
  }, [invoke]);
  useEffect(() => cancelOnClose, [cancelOnClose]);
  function close() {
    cancelOnClose();
    onClose();
  }
  async function login({ fresh = false, restart = false } = {}) {
    const previous = activeLogin.current;
    if (previous && !restart) return;
    if (restart && (!previous || previous.restarting)) return;
    const attempt = { id: crypto.randomUUID(), restarting: !!previous };
    activeLogin.current = attempt;
    setPhase(previous ? "restarting" : "waiting");
    setError("");
    setMissingCli(false);
    try {
      if (previous) {
        await invoke("cancelLogin", { requestId: previous.id });
        if (activeLogin.current !== attempt) return;
        attempt.restarting = false;
        setPhase("waiting");
      }
      await invoke("login", { provider, accountId: account?.id, requestId: attempt.id, fresh });
      if (activeLogin.current === attempt) await onDone();
    } catch (err) {
      if (activeLogin.current !== attempt) return;
      const message = errorText(err);
      setError(message);
      if (attempt.restarting) {
        // Keep ownership of the original request if cancellation itself failed.
        activeLogin.current = previous;
        setPhase("waiting");
        return;
      }
      setMissingCli(
        provider === "antigravity" && message.includes("未找到 Antigravity CLI（agy）"),
      );
    } finally {
      if (activeLogin.current === attempt) {
        activeLogin.current = null;
        setPhase("idle");
      }
    }
  }
  return (
    <Modal
      title={account ? tr("重新授权", "Reauthorize") : tr("添加订阅账号", "Add subscription account")}
      subtitle={
        retainedLogin
          ? tr("点击「继续设置」，按 Antigravity 终端提示完成剩余步骤。", "Choose Continue setup and follow the remaining steps in the Antigravity terminal.")
          : provider === "antigravity"
            ? tr("在浏览器中完成 Google 授权，结果会自动返回。首次使用时请按 Antigravity 提示完成设置。", "Authorize with Google in your browser. On first use, follow the Antigravity prompts to finish setup.")
            : tr("通过原生工具完成登录。", "Complete sign-in through the native CLI.")
      }
      onClose={close}
    >
      <form onSubmit={(event) => { event.preventDefault(); login(); }}>
        <Field label={tr("原生工具", "Native CLI")}>
          <Select
            disabled={busy || !!account}
            value={provider}
            onChange={(e) => {
              setProvider(e.target.value);
              setError("");
              setMissingCli(false);
            }}
          >
            {Object.entries(providers).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        {needsAntigravityBinding(account) ? (
          <p className="account-auth-hint">
            {account.email && (
              <>{tr("请在 Google 授权页选择", "On the Google sign-in page, choose")} <strong>{account.email}</strong>。</>
            )}
            {tr("授权成功后，已绑定的 Bot 将使用这个账号。", "Linked bots will use this account after authorization.")}
          </p>
        ) : account && (
          <div className="info-line">
            <KeyRound size={15} />
            {identityLabel(account)}
          </div>
        )}
        {busy && (
          <p className="busy-note" role="status">
            <Spinner />
            {phase === "restarting" ? tr("正在结束上一次授权…", "Ending the previous authorization…") : provider === "antigravity"
              ? tr("正在等待 Google 授权和 Antigravity 账号核验…", "Waiting for Google authorization and Antigravity account verification…")
              : tr("请完成原生登录，BoTeam 正在等待授权结果…", "Finish signing in. BoTeam is waiting for authorization…")}
          </p>
        )}
        <Notice>{error}</Notice>
        {retainedLogin && (
          <button
            type="button"
            className="text-btn"
            onClick={() => login({ fresh: true })}
          >
            {tr("重新选择 Google 账号", "Choose another Google account")}
          </button>
        )}
        {showInstallGuide && (
          <button
            type="button"
            className="text-btn"
            onClick={async () => {
              try {
                await invoke("openAntigravityInstall");
              } catch (err) {
                setError(errorText(err));
              }
            }}
          >
            <ExternalLink size={14} />
            {tr("查看官方 CLI 安装说明", "View the official CLI installation guide")}
          </button>
        )}
        <div className="form-actions">
          <Button onClick={close}>{busy ? tr("取消授权", "Cancel authorization") : tr("取消", "Cancel")}</Button>
          {busy ? (
            <Button variant="primary" icon={RefreshCw} busy={phase === "restarting"}
              onClick={() => login({ restart: true })}>
              {tr("重新开始授权", "Restart authorization")}
            </Button>
          ) : (
            <Button type="submit" variant="primary" icon={KeyRound}>
              {retainedLogin ? tr("继续设置", "Continue setup") : tr("开始授权", "Start authorization")}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
export function AccountDialog({
  account,
  bots,
  invoke,
  onClose,
  onDone,
  onLogin,
}) {
  const tr = useLanguage();
  const [note, setNote] = useState(account.note || "");
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function act(method, payload) {
    setBusy(true);
    setError("");
    try {
      await invoke(method, payload);
      await onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  const bound = bots.filter((b) => b.accountId === account.id && !b.archived);
  const pendingBinding = needsAntigravityBinding(account);
  const lastProbe = pendingBinding
    ? account.reason?.replace(
        "Antigravity 使用系统共享登录。当前原生接口无法核验独立账号身份与订阅，已限制派活。",
        "",
      ).trim()
    : account.reason;
  return (
    <Modal title={tr("管理订阅账号", "Manage subscription account")} onClose={onClose}>
      <div className="account-summary">
        <ProviderIcon provider={account.provider} />
        <div className="row-copy">
          <strong>{pendingBinding ? discoveryIdentity(account, tr) : identityLabel(account)}</strong>
          <small>
            {providerName(account.provider)}
            {account.plan ? ` · ${account.plan}` : ""}
          </small>
        </div>
        <Status status={account.status} />
      </div>
      <DetailList
        rows={[
          [tr("订阅额度", "Subscription quota"), account.quota],
          [tr("绑定 Bot", "Linked bots"), bound.map((b) => b.name).join("、") || tr("尚未绑定", "None linked")],
          [pendingBinding ? tr("上次检测", "Last scan") : tr("执行限制", "Execution restrictions"), lastProbe],
        ]}
      />
      <details className="account-technical">
        <summary>
          {tr("配置详情", "Configuration details")} <ChevronDown size={14} />
        </summary>
        <DetailList
          rows={[
            [
              tr("账号标识", "Account identity"),
              account.identity?.startsWith("source:")
                ? tr("本机配置 · 身份待核实", "Local configuration · identity unverified")
                : account.identity,
            ],
            ...technicalDetails(account, tr),
          ]}
        />
      </details>
      <Field label={tr("账号备注", "Account note")}>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={tr("例如，个人订阅", "For example, personal subscription")}
          maxLength={120}
        />
      </Field>
      {pendingBinding && (
        <p className="account-auth-hint">
          {account.email
            ? tr("点击「重新授权」，在 Google 页面选择上次登录的邮箱。", "Choose Reauthorize and select the email you last used to sign in to Google.")
            : tr("点击「重新授权」，在 Google 页面登录要绑定的账号。", "Choose Reauthorize and sign in to the Google account you want to link.")}
          {bound.length > 0 && tr("授权成功后可继续使用原有 Bot。", "Your existing bots will be available after authorization.")}
        </p>
      )}
      <button className="text-btn" onClick={onLogin}>
        <KeyRound size={14} />
        {tr("重新授权", "Reauthorize")}
      </button>
      <Notice>{error}</Notice>
      {confirm ? (
        <div className="danger-box">
          <strong>{tr("移除这个账号？", "Remove this account?")}</strong>
          <p>
            {bound.length ? tr(`绑定的 ${bound.length} 个 Bot 将被归档。`, `Linked bots will be archived (${bound.length}).`) : ""}
            {tr("已有聊天记录会保留。", "Your chat history will be kept.")}
          </p>
          <div className="actions">
            <Button onClick={() => setConfirm(false)}>{tr("取消", "Cancel")}</Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={() => act("removeAccount", { id: account.id })}
            >
              {tr("确认移除", "Confirm removal")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="form-actions spread">
          <button
            className="text-btn danger-text"
            onClick={() => setConfirm(true)}
          >
            {tr("移除账号", "Remove account")}
          </button>
          <Button
            variant="primary"
            busy={busy}
            onClick={() => act("note", { id: account.id, note: note.trim() })}
          >
            {tr("保存备注", "Save note")}
          </Button>
        </div>
      )}
    </Modal>
  );
}
