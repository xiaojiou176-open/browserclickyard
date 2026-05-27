import { memo, useId, useRef } from "react";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import { useModalA11y } from "../hooks/useModalA11y";
import { Button } from "./ui";

interface ConfirmDialogProps {
  locale?: UiLocale;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "danger" | "default";
  onConfirm: () => void;
  onCancel: () => void;
}

function ConfirmDialog({
  locale = DEFAULT_UI_LOCALE,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();

  useModalA11y({
    containerRef: dialogRef,
    initialFocusRef: cancelRef,
    onEscape: onCancel,
  });

  return (
    <div className="dialog-overlay">
      <button
        type="button"
        aria-label={pickUiText(locale, "Close confirmation dialog", "关闭确认对话框")}
        tabIndex={-1}
        onClick={onCancel}
        data-testid="confirm-dialog-overlay-close"
        style={{
          position: "fixed",
          inset: 0,
          border: "none",
          padding: 0,
          background: "transparent",
        }}
      />
      <div
        ref={dialogRef}
        className="dialog-box"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        style={{ position: "relative" }}
      >
        <h3 id={titleId}>{title}</h3>
        <p id={descId}>{message}</p>
        <div className="dialog-actions">
          <Button
            ref={cancelRef}
            type="button"
            variant="outline"
            onClick={onCancel}
            data-testid="confirm-dialog-cancel"
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={variant === "danger" ? "destructive" : "default"}
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default memo(ConfirmDialog);
