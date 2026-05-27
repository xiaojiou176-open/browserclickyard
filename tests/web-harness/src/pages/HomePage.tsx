import { CounterCard } from "../components/CounterCard";
import {
  Badge,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  SurfaceList,
} from "../components/ui";

export function HomePage(): JSX.Element {
  return (
    <div className="dashboard-grid">
      <CounterCard title="Primary Counter" />
      <Card as="section" tone="hero" className="summary-card" data-testid="home-summary">
        <CardHeader className="page-card-header">
          <div>
            <p className="ui-eyebrow">Coverage Story</p>
            <CardTitle>State Coverage Summary</CardTitle>
            <CardDescription>
              Cross-check route coverage, discovery entry points, and story-state readiness from one
              surface.
            </CardDescription>
          </div>
          <Badge variant="default">stable</Badge>
        </CardHeader>
        <CardContent>
          <SurfaceList className="summary-list">
            <li data-testid="summary-routes">Routes coverage enabled</li>
            <li data-testid="summary-discovery">Discovery crawler enabled</li>
            <li data-testid="summary-stories">Story states enabled</li>
          </SurfaceList>
        </CardContent>
      </Card>
    </div>
  );
}
