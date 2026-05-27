import { Route, Routes } from "react-router-dom";
import { NavBar } from "./components/NavBar";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui";
import { AboutPage } from "./pages/AboutPage";
import { ContactPage } from "./pages/ContactPage";
import { HomePage } from "./pages/HomePage";
import { SafePage } from "./pages/SafePage";
import { StoryPage } from "./pages/StoryPage";

export function App(): JSX.Element {
  return (
    <div className="app-shell" data-testid="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="app-header">
        <Card as="section" tone="hero" className="app-hero">
          <CardHeader className="page-card-header">
            <div>
              <p className="ui-eyebrow">UI Pressure Lab</p>
              <CardTitle className="app-title" data-testid="app-title">
                Browserclickyard Demo
              </CardTitle>
              <CardDescription>
                A shadcn-style verification surface for deterministic UI states, smoke flows, and
                component tests.
              </CardDescription>
            </div>
            <Badge variant="default">web</Badge>
          </CardHeader>
          <CardContent className="hero-facts">
            <span>Accessible focus</span>
            <span>Motion-aware surfaces</span>
            <span>Deterministic actions</span>
          </CardContent>
        </Card>
      </header>
      <NavBar />
      <main className="app-main" id="main-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/about" element={<AboutPage />} />
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/safe" element={<SafePage />} />
          <Route path="/stories/:storyId" element={<StoryPage />} />
        </Routes>
      </main>
    </div>
  );
}
