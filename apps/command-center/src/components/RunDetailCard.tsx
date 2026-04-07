import type { ReactNode } from "react";
import { memo } from "react";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "./ui";

interface RunDetailCardProps {
  title: string;
  status: string;
  isSuccess: boolean;
  detailHint: string;
  children: ReactNode;
}

function RunDetailCard({ title, status, isSuccess, detailHint, children }: RunDetailCardProps) {
  return (
    <Card>
      <CardHeader className="form-row justify-between">
        <CardTitle as="h2">{title}</CardTitle>
        <Badge variant={isSuccess ? "secondary" : "destructive"} className="chip">
          {status}
        </Badge>
      </CardHeader>
      <CardContent className="field-group">
        <p className="hint-text mb-2">{detailHint}</p>
        {children}
      </CardContent>
    </Card>
  );
}

export default memo(RunDetailCard);
