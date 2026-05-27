import {
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { NavLink, type NavLinkRenderProps } from "react-router-dom";

function cx(...tokens: Array<string | false | null | undefined>): string {
  return tokens.filter(Boolean).join(" ");
}

type ButtonVariant = "default" | "secondary" | "ghost" | "destructive";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  leadingIcon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", leadingIcon, children, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx("ui-btn", `ui-btn--${variant}`, leadingIcon && "ui-btn--with-icon", className)}
      {...props}
    >
      {leadingIcon ? <span className="ui-btn__icon">{leadingIcon}</span> : null}
      <span>{children}</span>
    </button>
  );
});

type CardProps = HTMLAttributes<HTMLElement> & {
  as?: "section" | "article" | "div";
  tone?: "default" | "hero" | "subtle";
};

export function Card({
  as = "section",
  className,
  tone = "default",
  ...props
}: CardProps): JSX.Element {
  const Component = as;
  return <Component className={cx("ui-card", `ui-card--${tone}`, className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cx("ui-card-header", className)} {...props} />;
}

export function CardTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>): JSX.Element {
  return <h2 className={cx("ui-card-title", className)} {...props} />;
}

export function CardDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>): JSX.Element {
  return <p className={cx("ui-card-description", className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cx("ui-card-content", className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cx("ui-card-footer", className)} {...props} />;
}

type BadgeVariant = "default" | "secondary" | "outline";

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
};

export function Badge({ className, variant = "secondary", ...props }: BadgeProps): JSX.Element {
  return <span className={cx("ui-badge", `ui-badge--${variant}`, className)} {...props} />;
}

type SurfaceListProps = HTMLAttributes<HTMLUListElement>;

export function SurfaceList({ className, ...props }: SurfaceListProps): JSX.Element {
  return <ul className={cx("ui-surface-list", className)} {...props} />;
}

type NavPillLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  to: string;
  testId: string;
  label?: string;
  caption?: string;
  children?: ReactNode;
};

export function NavPillLink({
  to,
  testId,
  label,
  caption,
  className,
  children,
  ...props
}: NavPillLinkProps): JSX.Element {
  return (
    <NavLink
      to={to}
      data-testid={testId}
      className={(state: NavLinkRenderProps) =>
        cx("ui-nav-pill", state.isActive && "active", className)
      }
      {...props}
    >
      <span className="ui-nav-pill__label">{label ?? children}</span>
      {caption ? <span className="ui-nav-pill__caption">{caption}</span> : null}
    </NavLink>
  );
}

export function NavShell({ className, ...props }: HTMLAttributes<HTMLElement>): JSX.Element {
  return <nav className={cx("ui-nav-shell", className)} {...props} />;
}
