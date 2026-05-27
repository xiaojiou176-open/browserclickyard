import { NavPillLink, NavShell } from "./ui";

export function NavBar(): JSX.Element {
  return (
    <NavShell className="app-nav" aria-label="Main navigation">
      <NavPillLink to="/" testId="nav-home" caption="Primary demo">
        Home
      </NavPillLink>
      <NavPillLink to="/about" testId="nav-about" caption="Harness notes">
        About
      </NavPillLink>
      <NavPillLink to="/contact" testId="nav-contact" caption="Feedback flow">
        Contact
      </NavPillLink>
      <NavPillLink to="/safe" testId="nav-safe" caption="Guardrails">
        Safe
      </NavPillLink>
      <NavPillLink to="/stories/counter-default" testId="nav-stories" caption="Component gallery">
        Stories
      </NavPillLink>
    </NavShell>
  );
}
