import { useLanguage } from "./preferences";
import React, { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist/build/pdf.min.mjs";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { IconButton, Notice, Spinner } from "./ui";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default function PdfPreview({ base64, zoom = 1 }) {
  const tr = useLanguage();
  const [doc, setDoc] = useState(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const canvasRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let loadedDoc = null;
    setLoading(true);
    setError("");
    setPageNumber(1);
    (async () => {
      try {
        const bytes = base64ToUint8Array(base64);
        const task = pdfjsLib.getDocument({ data: bytes });
        loadedDoc = await task.promise;
        if (!cancelled) {
          setDoc(loadedDoc);
          setLoading(false);
        } else {
          await loadedDoc.destroy();
        }
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || tr("无法加载此 PDF 预览。", "Could not load the PDF preview."));
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      loadedDoc?.destroy?.();
    };
  }, [base64]);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    let renderTask = null;
    (async () => {
      try {
        const page = await doc.getPage(pageNumber);
        if (cancelled || !canvasRef.current) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const baseViewport = page.getViewport({ scale: 1 });
        const fitScale = Math.min(1.25, 560 / Math.max(baseViewport.width, 1));
        const scale = fitScale * zoom;
        const viewport = page.getViewport({ scale: scale * dpr });
        const canvas = canvasRef.current;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const ctx = canvas.getContext("2d");
        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
      } catch (err) {
        if (!cancelled && err?.name !== "RenderingCancelledException") {
          setError(tr("无法渲染当前 PDF 页面。", "Could not render this PDF page."));
        }
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel?.();
    };
  }, [doc, pageNumber, zoom]);

  if (loading) {
    return (
      <div className="wp-empty" role="status">
        <Spinner /> {tr("正在加载 PDF 预览…", "Loading PDF preview…")}
      </div>
    );
  }
  if (error) return <Notice>{error}</Notice>;
  if (!doc) return null;

  return (
    <div className="fp-pdf-wrap">
      {doc.numPages > 1 && (
        <div className="fp-pdf-nav">
          <IconButton
            icon={ChevronLeft}
            label={tr("上一页", "Previous page")}
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((p) => Math.max(1, p - 1))}
          />
          <span>
            {tr("第", "Page")} {pageNumber} / {doc.numPages} {tr("页", " ")}
          </span>
          <IconButton
            icon={ChevronRight}
            label={tr("下一页", "Next page")}
            disabled={pageNumber >= doc.numPages}
            onClick={() => setPageNumber((p) => Math.min(doc.numPages, p + 1))}
          />
        </div>
      )}
      <div className="fp-pdf-stage">
        <canvas ref={canvasRef} className="fp-pdf-canvas" />
      </div>
    </div>
  );
}
