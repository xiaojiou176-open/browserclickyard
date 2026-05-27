import { memo } from "react";
import { Button } from "./ui";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon && <div className="empty-state-icon">{icon}</div>}
      <p className="empty-state-title">{title}</p>
      {description && <p className="empty-state-desc">{description}</p>}
      {action && (
        <div className="empty-state-action">
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={action.onClick}
            data-testid="empty-state-action"
          >
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
}

export default memo(EmptyState);
