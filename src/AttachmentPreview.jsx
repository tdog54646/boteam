import React, { useEffect, useState } from "react";

export function AttachmentPreview({ file, scope }) {
  const [image, setImage] = useState(null);
  useEffect(() => {
    let current = true;
    if (file.kind === "file") {
      window.boteam.invoke("attachmentThumbnail", { scope, id: file.id })
        .then(url => { if (current) setImage(url); })
        .catch(() => { if (current) setImage(null); });
    }
    return () => { current = false; };
  }, [scope, file.id, file.kind]);
  return image ? <img src={image} alt={file.name} className="attachment-preview" /> : null;
}
