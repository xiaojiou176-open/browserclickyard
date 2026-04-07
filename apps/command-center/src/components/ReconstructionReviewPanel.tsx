import type {
  ProfileResolvePayload,
  ReconstructionGeneratePayload,
  ReconstructionPreviewPayload,
} from "../types";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "./ui";

type Props = {
  artifacts: {
    session_dir?: string;
    video_path?: string;
    har_path?: string;
    html_path?: string;
  };
  mode: "gemini";
  strategy: "strict" | "balanced" | "aggressive";
  locale?: UiLocale;
  error: string;
  profileResolved: ProfileResolvePayload | null;
  preview: ReconstructionPreviewPayload | null;
  generated: ReconstructionGeneratePayload | null;
  onArtifactsChange: (next: {
    session_dir?: string;
    video_path?: string;
    har_path?: string;
    html_path?: string;
  }) => void;
  onModeChange: (mode: "gemini") => void;
  onStrategyChange: (strategy: "strict" | "balanced" | "aggressive") => void;
  onResolveProfile: () => void;
  onPreview: () => void;
  onGenerate: () => void;
  onOrchestrate: () => void;
};

export default function ReconstructionReviewPanel(props: Props) {
  const updateField = (key: keyof Props["artifacts"], value: string) => {
    props.onArtifactsChange({ ...props.artifacts, [key]: value });
  };
  const locale = props.locale ?? DEFAULT_UI_LOCALE;
  const sessionDirId = "reconstruction-session-dir";
  const harPathId = "reconstruction-har-path";
  const htmlPathId = "reconstruction-html-path";
  const videoPathId = "reconstruction-video-path";
  const videoAnalysisModeId = "reconstruction-video-analysis-mode";
  const extractorStrategyId = "reconstruction-extractor-strategy";

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">
          {pickUiText(locale, "Reconstruction Review", "\u91cd\u5efa\u5ba1\u67e5")}
        </CardTitle>
      </CardHeader>
      {props.error && (
        <div className="error-text" role="alert" aria-live="assertive">
          <p>{props.error}</p>
        </div>
      )}
      <CardContent className="field-group">
        <div className="field">
          <label className="field-label" htmlFor={sessionDirId}>
            {pickUiText(locale, "session_dir", "session_dir \u8def\u5f84")}
          </label>
          <input
            id={sessionDirId}
            className="field-input"
            value={props.artifacts.session_dir ?? ""}
            onChange={(e) => updateField("session_dir", e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={harPathId}>
            {pickUiText(locale, "har_path", "har_path \u8def\u5f84")}
          </label>
          <input
            id={harPathId}
            className="field-input"
            value={props.artifacts.har_path ?? ""}
            onChange={(e) => updateField("har_path", e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={htmlPathId}>
            {pickUiText(locale, "html_path", "html_path \u8def\u5f84")}
          </label>
          <input
            id={htmlPathId}
            className="field-input"
            value={props.artifacts.html_path ?? ""}
            onChange={(e) => updateField("html_path", e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={videoPathId}>
            {pickUiText(locale, "video_path", "video_path \u8def\u5f84")}
          </label>
          <input
            id={videoPathId}
            className="field-input"
            value={props.artifacts.video_path ?? ""}
            onChange={(e) => updateField("video_path", e.target.value)}
          />
        </div>
        <div className="form-row">
          <div className="field flex-1">
            <label className="field-label" htmlFor={videoAnalysisModeId}>
              {pickUiText(locale, "video_analysis_mode", "video_analysis_mode")}
            </label>
            <select
              id={videoAnalysisModeId}
              className="field-select"
              value={props.mode}
              onChange={(e) => props.onModeChange(e.target.value as "gemini")}
            >
              <option value="gemini">gemini</option>
            </select>
          </div>
          <div className="field flex-1">
            <label className="field-label" htmlFor={extractorStrategyId}>
              {pickUiText(locale, "extractor_strategy", "extractor_strategy")}
            </label>
            <select
              id={extractorStrategyId}
              className="field-select"
              value={props.strategy}
              onChange={(e) =>
                props.onStrategyChange(e.target.value as "strict" | "balanced" | "aggressive")
              }
            >
              <option value="strict">strict</option>
              <option value="balanced">balanced</option>
              <option value="aggressive">aggressive</option>
            </select>
          </div>
        </div>
        <div className="form-actions">
          <Button type="button" variant="outline" size="sm" onClick={props.onResolveProfile}>
            {pickUiText(locale, "Resolve Profile", "\u89e3\u6790 Profile")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={props.onPreview}>
            {pickUiText(locale, "Preview", "\u9884\u89c8")}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={props.onGenerate}>
            {pickUiText(locale, "Generate", "\u751f\u6210")}
          </Button>
          <Button type="button" variant="default" size="sm" onClick={props.onOrchestrate}>
            {pickUiText(locale, "Orchestrate", "\u7f16\u6392\u6267\u884c")}
          </Button>
        </div>
      </CardContent>

      <div className="field-group mt-3">
        {props.profileResolved && (
          <div className="card-raised p-3">
            <p>
              {"profile="}
              <Badge variant="outline">{props.profileResolved.profile}</Badge>
            </p>
            <p>{`dom_alignment=${props.profileResolved.dom_alignment_score} har_alignment=${props.profileResolved.har_alignment_score}`}</p>
            <p>{`manual_handoff_required=${props.profileResolved.manual_handoff_required}`}</p>
          </div>
        )}
        {props.preview && (
          <div className="card-raised p-3">
            <p>{`preview_id=${props.preview.preview_id}`}</p>
            <p>{`quality=${props.preview.reconstructed_flow_quality}`}</p>
            <p>{`unresolved=${props.preview.unresolved_segments.join(",") || "none"}`}</p>
          </div>
        )}
        {props.generated && (
          <div className="card-raised p-3">
            <p>{`flow_id=${props.generated.flow_id}`}</p>
            <p>{`template_id=${props.generated.template_id}`}</p>
            <p>{`manual_handoff_required=${props.generated.manual_handoff_required}`}</p>
          </div>
        )}
      </div>
    </Card>
  );
}
