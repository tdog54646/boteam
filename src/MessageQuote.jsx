import React from "react";
import { Quote } from "lucide-react";

export function MessageQuote({ message, descriptionId }) {
  const excerpt = [...message.text.slice(0, 320)].slice(0, 160).join("");
  return (
    <>
      <Quote size={14} aria-hidden="true" />
      <span className="quote-summary" id={descriptionId}>
        <strong>{message.name}</strong>
        <span>{excerpt.replace(/\s+/gu, " ")}{excerpt.length < message.text.length && "…"}</span>
      </span>
    </>
  );
}
