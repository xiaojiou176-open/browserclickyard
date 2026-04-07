import { useMemo } from "react";
import { useParams } from "react-router-dom";
import { CounterCard } from "../components/CounterCard";
import { FeedbackForm } from "../components/FeedbackForm";
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui";

type StoryDefinition = {
  id: string;
  title: string;
  render: () => JSX.Element;
};

const STORIES: StoryDefinition[] = [
  {
    id: "counter-default",
    title: "Counter / Default",
    render: () => <CounterCard title="Story Counter" />,
  },
  {
    id: "feedback-default",
    title: "Feedback / Default",
    render: () => <FeedbackForm />,
  },
];

export function StoryPage(): JSX.Element {
  const params = useParams();
  const story = useMemo(
    () => STORIES.find((item) => item.id === params.storyId) ?? STORIES[0],
    [params.storyId],
  );

  return (
    <Card as="section" tone="hero" className="story-surface" data-testid="story-page">
      <CardHeader className="page-card-header">
        <div>
          <p className="ui-eyebrow">Story States</p>
          <CardTitle data-testid="story-title">{story.title}</CardTitle>
          <CardDescription>
            Preview components inside the same surface language used by the app shell and
            navigation.
          </CardDescription>
        </div>
        <Badge variant="outline">story</Badge>
      </CardHeader>
      <CardContent data-testid="story-content">{story.render()}</CardContent>
    </Card>
  );
}
