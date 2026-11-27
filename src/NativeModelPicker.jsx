import { useLanguage } from "./preferences";
import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight, RotateCcw, Zap } from "lucide-react";
import "./model-picker.css";

function modelName(item) {
  const name = item?.label || item?.id || "";
  const gpt = /^gpt-(\d+(?:\.\d+)*)(?:-([a-z\d.]+(?:-[a-z\d.]+)*))?$/i.exec(
    name,
  );
  if (!gpt) return name;
  const suffix = gpt[2]
    ?.split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1));
  return ["GPT-" + gpt[1], ...(suffix || [])].join(" ");
}

export function modelLabelFor(catalog, id) {
  return modelName(catalog?.models?.find((item) => item.id === id) || { id });
}

const codexEfforts = {
  none: "无", minimal: "极低", low: "轻度", medium: "中", high: "高",
  xhigh: "极高", max: "Max", ultra: "Ultra",
};

function effortName(value, provider, tr) {
  if (provider === "codex" && Object.hasOwn(codexEfforts, value?.toLowerCase()))
    return tr(codexEfforts[value.toLowerCase()], value === "xhigh" ? "Extra high" : value[0].toUpperCase() + value.slice(1));
  if (value === "xhigh") return "Extra high";
  return /^[a-z]+$/.test(value || "")
    ? value[0].toUpperCase() + value.slice(1)
    : value;
}

export function describeModel(catalog, model, effort, provider, tr = (zh) => zh) {
  const modelId = model || catalog?.defaultModel;
  const entry = catalog?.models?.find((item) => item.id === modelId);
  const levels =
    (model ? entry?.efforts : (catalog?.efforts ?? entry?.efforts)) || [];
  const defaultEffort =
    (modelId === catalog?.defaultModel && catalog?.defaultEffort) ||
    entry?.defaultEffort;
  const effortId = effort || defaultEffort;
  const level = levels.find((item) => item.id === effortId);
  return {
    modelId,
    levels,
    effortId,
    modelLabel: modelName(entry || { id: modelId }) || tr("原生默认", "CLI default"),
    effortLabel: effortName(level?.label || effortId, provider, tr),
    maximum: levels.length > 1 && level === levels.at(-1),
  };
}

function ModelMenu({ catalog, model, provider, busy, loading, status, onChoose, onBack }) {
  const tr = useLanguage();
  const menu = useRef(null);
  const items = catalog?.models || [];
  const currentMissing = model && !items.some((item) => item.id === model);
  const defaultEntry = items.find((item) => item.id === catalog?.defaultModel);
  const checkedId = model || defaultEntry?.id || "";
  useLayoutEffect(() => {
    const node = menu.current;
    if (document.activeElement !== document.body && document.activeElement !== node) return;
    const selected =
      node.querySelector('[aria-checked="true"]:enabled') ||
      node.querySelector("button:enabled");
    (selected || node).focus({ preventScroll: true });
    selected?.scrollIntoView({ block: "nearest" });
  }, [loading, catalog]);
  function navigate(event) {
    if (event.key === "Escape" || event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      onBack();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const rows = [...menu.current.querySelectorAll("button:enabled")];
    const index = rows.indexOf(document.activeElement);
    let next = index + (event.key === "ArrowDown" ? 1 : -1);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = rows.length - 1;
    rows[(next + rows.length) % rows.length]?.focus();
  }
  function row(id, label, detail, disabled = false) {
    return (
      <button
        key={id}
        type="button"
        role="menuitemradio"
        aria-checked={checkedId === id}
        aria-label={id ? label : tr("原生默认", "CLI default")}
        aria-disabled={busy || disabled}
        disabled={disabled}
        className="native-model-row"
        title={detail ? label + " · " + detail : label}
        onClick={() => {
          if (!busy) onChoose(id);
        }}
      >
        <span>
          {label}
          {detail && <small>{detail}</small>}
        </span>
        {checkedId === id && (
          <Check size={15} strokeWidth={1.7} aria-hidden="true" />
        )}
      </button>
    );
  }
  return (
    <div
      className="native-model-menu"
      role="menu"
      aria-label={tr("模型", "Model")}
      tabIndex={-1}
      ref={menu}
      onKeyDownCapture={navigate}
    >
      {!loading && row(
        "",
        tr("默认", "Default"),
        provider === "codex" ? tr("推荐模型集", "Recommended models") : modelName(defaultEntry),
      )}
      {!loading && items.map((item) => row(item.id, modelName(item)))}
      {!loading && currentMissing &&
        row(model, modelName({ id: model }), tr("已保存，当前未列出", "Saved, currently unlisted"), true)}
      {status}
    </div>
  );
}

export function NativeModelPicker({
  catalog,
  model = "",
  effort = "",
  provider,
  busy = false,
  loading = false,
  refresh,
  onChange,
  onReset,
  resetLabel,
  resetDisabled = false,
}) {
  const tr = useLanguage();
  const [showModels, setShowModels] = useState(false);
  const [preview, setPreview] = useState(null);
  const switchButton = useRef(null);
  const inMenu = useRef(false);
  const dragging = useRef(false);
  const selectionId = useId();
  const { levels, modelLabel, effortId, effortLabel } = describeModel(
    catalog,
    model,
    effort,
    provider, tr,
  );
  const selected = levels.findIndex((level) => level.id === effortId);
  const index = preview ?? selected;
  const level = levels[index];
  const caption =
    effortName(level?.label || level?.id, provider, tr) || effortLabel || tr("原生默认", "CLI default");
  const single = levels.length === 1;
  const locked = busy || loading;
  const reason = catalog?.reason || (catalog && !catalog.models?.length && tr("原生工具未返回可选模型。", "The CLI did not return any model options."));
  const status = (loading || reason) && (
    <p className="native-model-status" role="status">
      {loading ? tr("正在读取原生模型…", "Loading CLI models…") : reason}
      {!loading && refresh && (
        <button type="button" className="text-btn" onClick={refresh}>{tr("重新读取", "Reload")}</button>
      )}
    </p>
  );

  useLayoutEffect(() => {
    if (!showModels && inMenu.current)
      switchButton.current?.focus({ preventScroll: true });
    inMenu.current = showModels;
  }, [showModels]);

  function openModels() {
    if (!busy) setShowModels(true);
  }
  function chooseModel(id) {
    const available = describeModel(catalog, id, "").levels;
    const patch = { model: id };
    if (effort && !available.some((item) => item.id === effort))
      patch.effort = "";
    setShowModels(false);
    onChange(patch);
  }
  function commit(index) {
    setPreview(null);
    if (!locked && levels[index]) onChange({ effort: levels[index].id });
  }
  function step(event) {
    let next;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = levels.length - 1;
    else if (["ArrowRight", "ArrowUp"].includes(event.key)) next = selected + 1;
    else if (["ArrowLeft", "ArrowDown"].includes(event.key))
      next = selected - 1;
    else return;
    event.preventDefault();
    commit(Math.max(0, Math.min(levels.length - 1, next)));
  }
  return (
    <div className="native-model-picker" aria-busy={locked}
      data-maximum={(levels.length > 1 && index === levels.length - 1) || undefined}>
      {showModels ? (
        <ModelMenu
          catalog={catalog}
          model={model}
          provider={provider}
          busy={busy}
          loading={loading}
          status={status}
          onChoose={chooseModel}
          onBack={() => setShowModels(false)}
        />
      ) : (
        <div className="native-model-card">
          <div className="native-model-heading">
            <button
              type="button"
              className="model-icon"
              title={tr("使用模型默认思考强度", "Use model default reasoning effort")}
              aria-label={tr("使用模型默认思考强度", "Use model default reasoning effort")}
              disabled={locked || !effort}
              onClick={() => onChange({ effort: "" })}
            >
              <Zap size={15} strokeWidth={1.65} aria-hidden="true" />
            </button>
            <button
              type="button"
              ref={switchButton}
              className="native-model-switch"
              aria-label={tr("选择模型", "Choose model")}
              data-popover-focus
              aria-describedby={selectionId}
              aria-haspopup="menu"
              aria-expanded={showModels}
              aria-disabled={busy}
              onClick={openModels}
              onKeyDown={(event) => {
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  event.preventDefault();
                  openModels();
                }
              }}
            >
              <strong>{caption}</strong>
              <span id={selectionId} title={modelLabel}>
                <span>{modelLabel}</span>
                <ChevronRight size={11} aria-hidden="true" />
              </span>
            </button>
            <button
              type="button"
              className="model-icon"
              title={resetLabel ?? tr("恢复 Bot 默认设置", "Restore bot defaults")}
              aria-label={resetLabel ?? tr("恢复 Bot 默认设置", "Restore bot defaults")}
              disabled={locked || resetDisabled}
              onClick={onReset}
            >
              <RotateCcw size={15} strokeWidth={1.65} aria-hidden="true" />
            </button>
          </div>
          {levels.length > 1 && (
            <div
              className="native-effort-track"
              data-unknown={index < 0 || undefined}
              style={{ "--fraction": Math.max(0, index) / (levels.length - 1) }}
            >
              <div className="native-effort-stops" aria-hidden="true">
                {levels.map((level) => (
                  <i key={level.id} />
                ))}
              </div>
              <input
                type="range"
                min={0}
                max={levels.length - 1}
                step={1}
                value={Math.max(0, index)}
                aria-label={tr("思考强度", "Reasoning effort")}
                aria-valuetext={caption}
                aria-disabled={locked}
                onKeyDown={step}
                onPointerDown={(event) => {
                  if (locked || event.button !== 0) {
                    event.preventDefault();
                    return;
                  }
                  dragging.current = true;
                  event.currentTarget.setPointerCapture(event.pointerId);
                }}
                onChange={(event) => {
                  if (locked) return;
                  const next = event.currentTarget.valueAsNumber;
                  if (dragging.current) setPreview(next);
                  else commit(next);
                }}
                onPointerUp={(event) => {
                  if (!dragging.current) return;
                  dragging.current = false;
                  commit(event.currentTarget.valueAsNumber);
                }}
                onLostPointerCapture={() => {
                  dragging.current = false;
                  setPreview(null);
                }}
              />
            </div>
          )}
          {single && (
            <button
              type="button"
              className="native-effort-single"
              aria-pressed={selected === 0}
              disabled={locked}
              onClick={() => commit(0)}
            >
              {effortName(levels[0].label || levels[0].id, provider, tr)}
              {selected === 0 && <Check size={13} aria-hidden="true" />}
            </button>
          )}
          {status}
          {effort && selected < 0 && catalog && !loading && !reason && (
            <p className="native-model-status">
              {tr("已保存的强度", "Saved reasoning effort")} {effortName(effort, provider, tr)} {tr("当前未列出。", " is currently unlisted.")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
