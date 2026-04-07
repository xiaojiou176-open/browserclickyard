import { memo } from "react";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";

interface EvidenceScreenshotPairProps {
  locale?: UiLocale;
  beforeImageUrl: string | null | undefined;
  afterImageUrl: string | null | undefined;
  beforeAlt: string;
  afterAlt: string;
  beforeLabel?: string;
  afterLabel?: string;
  emptyHint?: string;
}

function EvidenceScreenshotPair({
  locale = DEFAULT_UI_LOCALE,
  beforeImageUrl,
  afterImageUrl,
  beforeAlt,
  afterAlt,
  beforeLabel,
  afterLabel,
  emptyHint,
}: EvidenceScreenshotPairProps) {
  const hasAnyScreenshot = Boolean(beforeImageUrl || afterImageUrl);
  const resolvedBeforeLabel =
    beforeLabel ?? pickUiText(locale, "Before execution", "执行前");
  const resolvedAfterLabel =
    afterLabel ?? pickUiText(locale, "After execution", "执行后");

  return (
    <>
      <div className="evidence-grid">
        {beforeImageUrl && (
          <div>
            <p className="hint-text">{resolvedBeforeLabel}</p>
            <img src={beforeImageUrl} alt={beforeAlt} className="evidence-img" />
          </div>
        )}
        {afterImageUrl && (
          <div>
            <p className="hint-text">{resolvedAfterLabel}</p>
            <img src={afterImageUrl} alt={afterAlt} className="evidence-img" />
          </div>
        )}
      </div>
      {!hasAnyScreenshot && emptyHint && <p className="hint-text">{emptyHint}</p>}
    </>
  );
}

export default memo(EvidenceScreenshotPair);
