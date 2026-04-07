export type StoryState = {
  id: string;
  path: string;
  source: "stories";
};

export const storyStates: StoryState[] = [
  { id: "story_counter_default", path: "/stories/counter-default", source: "stories" },
  { id: "story_feedback_default", path: "/stories/feedback-default", source: "stories" },
];
