import React from "react";
import { usePreferences } from "./preferences";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function ProfileAvatar({ className = "" }) {
  const { profile } = usePreferences();
  const name = profile.displayName;
  const avatarClass = `local-user-avatar ${className}`;
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
