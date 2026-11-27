import React from "react";

const icons = import.meta.glob("./channel-icons/*", { eager: true, import: "default" });

export function PlatformIcon({ id }) {
  const extension = id === "discord" ? "svg" : "jpg";
  return <img className={"channel-icon " + id} alt="" draggable={false} src={icons[`./channel-icons/${id}.${extension}`]} />;
}

export function statusLabel(status, t) {
  const label = {
    connected: ["已连接", "Connected"],
    connecting: ["连接中", "Connecting"],
    disconnected: ["未连接", "Disconnected"],
    pairing: ["等待扫码", "Waiting for scan"],
    scanned: ["已扫码", "Scanned"],
    expired: ["二维码已过期", "QR code expired"],
    pin: ["等待验证码", "Waiting for verification"],
    error: ["连接失败", "Connection failed"],
  }[status] || ["未配置", "Not configured"];
  return t(...label);
}
