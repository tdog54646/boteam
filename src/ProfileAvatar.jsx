import React, { useState } from "react";
import { usePreferences } from "./preferences";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function ProfileAvatar({ className = "", profile }) {
  const { profile: saved, t } = usePreferences();
  const [failedImage, setFailedImage] = useState("");
  const name = profile?.displayName?.trim() || saved.displayName || t("用户", "User");
  const avatar = profile?.avatar ?? saved.avatar;
  const avatarClass = `local-user-avatar ${className}`;
  if (avatar && avatar !== failedImage) {
    return <img className={avatarClass} src={avatar} alt="" draggable={false}
      style={{ background: "transparent" }} onError={() => setFailedImage(avatar)}/>;
  }
  const words = name.split(/\s+/);
  let initials;
  if (words.length > 1) {
    initials = [words[0], words.at(-1)].map(word => graphemes.segment(word).containing(0).segment).join("");
  } else {
    const length = /^\p{Script=Latin}/u.test(name) ? 2 : 1;
    initials = Array.from(graphemes.segment(name)).slice(0, length).map(part => part.segment).join("");
  }
  return <span aria-hidden="true" className={avatarClass}>{initials.toLocaleUpperCase()}</span>;
}
