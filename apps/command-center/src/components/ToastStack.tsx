import { type CSSProperties, memo, useEffect, useRef, useState } from "react";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import type { LogLevel, UiNotice } from "../types";

const iconMap: Record<LogLevel, string> = {
  info: "i",
  success: "\u2713",
  warn: "!",
  error: "\u2717",
};

interface ToastStackProps {
  notices: UiNotice[];
  locale?: UiLocale;
  onDismiss: (id: string) => void;
}

function ToastStack({ notices, locale = DEFAULT_UI_LOCALE, onDismiss }: ToastStackProps) {
  const [closingIds, setClosingIds] = useState<string[]>([]);
  const timersRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timerId) => window.clearTimeout(timerId));
      timers.clear();
    };
  }, []);

  const beginDismiss = (id: string) => {
    if (closingIds.includes(id)) {
      return;
    }
    setClosingIds((prev) => [...prev, id]);
    const timeoutId = window.setTimeout(() => {
      onDismiss(id);
      timersRef.current.delete(id);
      setClosingIds((prev) => prev.filter((item) => item !== id));
    }, 160);
    timersRef.current.set(id, timeoutId);
  };

  if (notices.length === 0) {
    return null;
  }

  return (
    <div
      className="toast-stack"
      aria-live="polite"
      aria-label={pickUiText(locale, "Notice list", "通知列表")}
    >
      {notices.map((notice, index) => {
        const isClosing = closingIds.includes(notice.id);
        return (
          <button
            type="button"
            key={notice.id}
            className={`toast-item ${notice.level}`}
            data-state={isClosing ? "closing" : "open"}
            data-level={notice.level}
            style={{ "--toast-index": index } as CSSProperties}
            onClick={() => beginDismiss(notice.id)}
            disabled={isClosing}
            aria-disabled={isClosing}
            aria-label={pickUiText(
              locale,
              `Close notification: ${notice.message}`,
              `关闭通知：${notice.message}`,
            )}
          >
            <span className="toast-icon" aria-hidden="true">
              {iconMap[notice.level]}
            </span>
            <p>{notice.message}</p>
          </button>
        );
      })}
    </div>
  );
}

export default memo(ToastStack);
