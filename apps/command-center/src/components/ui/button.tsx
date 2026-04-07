import type { ButtonHTMLAttributes } from "react";
import { forwardRef } from "react";

import { cn } from "../../lib/cn";

export type ButtonVariant = "default" | "secondary" | "outline" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  "data-state"?: string;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", size = "md", type = "button", loading = false, ...props },
  ref,
) {
  const ariaBusy = props["aria-busy"];
  const dataState = props["data-state"];
  const isLoading = loading || dataState === "loading" || ariaBusy === true || ariaBusy === "true";
  const isDisabled = Boolean(props.disabled || isLoading);

  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={isLoading ? true : ariaBusy}
      data-loading={isLoading ? "true" : undefined}
      className={cn(
        "ui-btn",
        `ui-btn--${variant}`,
        `ui-btn--${size}`,
        isLoading && "ui-btn--loading",
        className,
      )}
    />
  );
});

export { Button };
