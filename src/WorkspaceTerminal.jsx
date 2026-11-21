import React, { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { RefreshCw, Square } from "lucide-react";
import { errorText, IconButton, Notice } from "./ui";
import "@xterm/xterm/css/xterm.css";

export default function TerminalView({ call, active }) {
  const host = useRef(null);
  const emulator = useRef(null);
  const [run, setRun] = useState(0);
  const [session, setSession] = useState(null);
  const [exit, setExit] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const element = host.current;
    let current = true;
    let sessionId;
    let timer;
    let offset = 0;
    let ended = false;
    const style = getComputedStyle(element);
    function theme() {
      const background = style.getPropertyValue("--canvas").trim();
      const foreground = style.getPropertyValue("--fg").trim();
      return { background, foreground, cursor: foreground, cursorAccent: background };
    }
    const term = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      fontFamily: style.getPropertyValue("--mono").trim(),
      fontSize: 12,
      scrollback: 4000,
      screenReaderMode: true,
      theme: theme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    term.textarea?.setAttribute("aria-label", "终端输入");
    function resize() {
      if (element.clientWidth && element.clientHeight) fit.fit();
    }
    resize();
    emulator.current = { term, resize };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const appearance = matchMedia("(prefers-color-scheme: dark)");
    const themeChanged = () => { term.options.theme = theme(); };
    appearance.addEventListener("change", themeChanged);
    setSession(null);
    setExit(null);
    setError("");

    function send(method, payload) {
      if (!sessionId || ended) return;
      call(method, { id: sessionId, ...payload }).catch((err) => {
        if (current) setError(errorText(err));
      });
    }
    term.onResize((dimensions) => send("panelTerminalResize", dimensions));
    term.onData((input) => send("panelTerminalInput", { input }));
    async function read() {
      try {
        const result = await call("panelTerminalRead", { id: sessionId, offset });
        if (!current) return;
        offset = result.offset;
        if (result.output) term.write(result.output);
        if (result.exited) {
          ended = true;
          setExit({ code: result.code });
        } else {
          timer = setTimeout(read, element.clientWidth ? (result.output ? 18 : 60) : 400);
        }
      } catch (err) {
        if (current) { ended = true; setError(errorText(err)); setExit({}); }
      }
    }
    const close = (id) => call("panelTerminalClose", { id }).catch(() => {});
    call("panelTerminalStart", { cols: term.cols, rows: term.rows }).then((started) => {
      if (!current) return close(started.id);
      sessionId = started.id;
      setSession(started);
      send("panelTerminalResize", { cols: term.cols, rows: term.rows });
      read();
    }).catch((err) => { if (current) setError(errorText(err)); });

    return () => {
      current = false;
      clearTimeout(timer);
      if (sessionId) close(sessionId);
      observer.disconnect();
      appearance.removeEventListener("change", themeChanged);
      emulator.current = null;
      term.dispose();
    };
  }, [call, run]);
  useEffect(() => {
    if (!active || !session) return;
    emulator.current?.resize();
    emulator.current?.term.focus();
  }, [active, session]);

  return <>
    <div className="wp-tools">
      <span className="wp-tool-title" title={session?.cwd}>{session?.cwd || "终端"}</span>
      {exit || (!session && error) ?
        <IconButton icon={RefreshCw} label="重新启动终端" onClick={() => setRun(run + 1)} /> :
        <IconButton icon={Square} label="中断当前命令" disabled={!session}
          onClick={() => call("panelTerminalInterrupt", { id: session.id }).catch((err) => setError(errorText(err)))} />}
    </div>
    <Notice>{error}</Notice>
    <div className="wp-terminal" ref={host} onKeyDown={(event) => event.stopPropagation()} />
    {exit && <p className="wp-empty">终端已退出{exit.code != null && " · " + exit.code}</p>}
  </>;
}
