import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { DEFAULT_UI_LOCALE, pickUiText, type UiLocale } from "../i18n/uiLocale";
import type { Command, CommandCategory, CommandState } from "../types";
import { categoryMeta, guessCategory, isAiCommand, isDangerous } from "../utils/commands";
import { Badge, Button, Card, CardContent, CardFooter, CardHeader } from "./ui";

interface CommandGridProps {
  commands: Command[];
  locale?: UiLocale;
  commandState: CommandState;
  activeTab: "all" | CommandCategory;
  submittingId: string;
  feedbackText: string;
  onActiveTabChange: (tab: "all" | CommandCategory) => void;
  onRunCommand: (command: Command) => void;
}

function CommandGrid({
  commands,
  locale = DEFAULT_UI_LOCALE,
  commandState,
  activeTab,
  submittingId,
  feedbackText,
  onActiveTabChange,
  onRunCommand,
}: CommandGridProps) {
  const loadingSkeletonIds = useMemo(() => Array.from({ length: 6 }, (_, idx) => idx), []);
  const tabOrder: Array<"all" | CommandCategory> = useMemo(
    () => ["all", ...(Object.keys(categoryMeta) as CommandCategory[])],
    [],
  );
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeTabIndex = tabOrder.indexOf(activeTab);

  const focusTabByIndex = useCallback(
    (targetIndex: number) => {
      const normalizedIndex = ((targetIndex % tabOrder.length) + tabOrder.length) % tabOrder.length;
      tabRefs.current[normalizedIndex]?.focus();
    },
    [tabOrder],
  );

  const activateTabByIndex = useCallback(
    (targetIndex: number) => {
      const normalizedIndex = ((targetIndex % tabOrder.length) + tabOrder.length) % tabOrder.length;
      onActiveTabChange(tabOrder[normalizedIndex]);
    },
    [onActiveTabChange, tabOrder],
  );

  const handleTabKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        focusTabByIndex(index + 1);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        focusTabByIndex(index - 1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        focusTabByIndex(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        focusTabByIndex(tabOrder.length - 1);
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateTabByIndex(index);
      }
    },
    [activateTabByIndex, focusTabByIndex, tabOrder.length],
  );

  const filteredCommands = useMemo(() => {
    if (activeTab === "all") {
      return commands;
    }
    return commands.filter((cmd) => guessCategory(cmd) === activeTab);
  }, [activeTab, commands]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { all: commands.length };
    for (const cmd of commands) {
      const cat = guessCategory(cmd);
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    return counts;
  }, [commands]);

  const localizeCategoryLabel = useCallback(
    (category: CommandCategory) =>
      pickUiText(
        locale,
        categoryMeta[category].label,
        {
          init: "初始化",
          pipeline: "流水线",
          frontend: "前端",
          automation: "自动化",
          maintenance: "维护",
          backend: "后端",
        }[category],
      ),
    [locale],
  );

  return (
    <>
      <div
        className="category-tabs"
        role="tablist"
        aria-label={pickUiText(locale, "Command categories", "命令分类")}
      >
        <Button
          ref={(node) => {
            tabRefs.current[0] = node;
          }}
          variant="ghost"
          size="sm"
          id="command-category-tab-all"
          className={`category-tab ${activeTab === "all" ? "active" : ""}`}
          role="tab"
          aria-selected={activeTab === "all"}
          aria-controls="command-category-panel"
          tabIndex={activeTab === "all" ? 0 : -1}
          onClick={() => onActiveTabChange("all")}
          onKeyDown={(event) => handleTabKeyDown(event, 0)}
          data-testid="commandgrid-category-all"
        >
          {pickUiText(locale, "All", "全部")}
          <span className="cat-count">{categoryCounts.all ?? 0}</span>
        </Button>
        {(Object.keys(categoryMeta) as CommandCategory[]).map((cat) => (
          <Button
            ref={(node) => {
              tabRefs.current[tabOrder.indexOf(cat)] = node;
            }}
            variant="ghost"
            size="sm"
            key={cat}
            id={`command-category-tab-${cat}`}
            className={`category-tab ${activeTab === cat ? "active" : ""}`}
            role="tab"
            aria-selected={activeTab === cat}
            aria-controls="command-category-panel"
            tabIndex={activeTab === cat ? 0 : -1}
            onClick={() => onActiveTabChange(cat)}
            onKeyDown={(event) => handleTabKeyDown(event, tabOrder.indexOf(cat))}
            data-testid={
              cat === "pipeline" ? "commandgrid-category-pipeline" : `commandgrid-category-${cat}`
            }
          >
            {localizeCategoryLabel(cat)}
            <span className="cat-count">{categoryCounts[cat] ?? 0}</span>
          </Button>
        ))}
      </div>

      <div
        id="command-category-panel"
        className="command-grid"
        role="tabpanel"
        aria-labelledby={`command-category-tab-${tabOrder[activeTabIndex] ?? "all"}`}
        aria-busy={commandState === "loading"}
      >
        {commandState === "success" && (
          <div className="empty-state grid-full">
            <p className="empty-state-title">
              {pickUiText(locale, "Capability-driven lab commands", "能力驱动的实验命令")}
            </p>
            <p className="empty-state-desc">
              {pickUiText(
                locale,
                "Use the cards below as launchers for browser experiments. If the engineering categories feel too low-level, start with the lab-mode guide above and treat these cards as the concrete entrypoints.",
                "把下面这些卡片当成浏览器实验的启动器。如果工程分类显得太底层，就先看上面的实验模式指南，再把这些卡片当成具体入口。",
              )}
            </p>
          </div>
        )}
        {commandState === "loading" && (
          <>
            <Card
              className="loading-card grid-full"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <CardContent>
                <div className="spinner" />
                <p className="empty-state-title mt-3">
                  {pickUiText(locale, "Loading lab commands", "正在加载实验命令")}
                </p>
                <p className="empty-state-desc">
                  {pickUiText(
                    locale,
                    "Waiting for the backend command catalog. When it responds, choose a card to start a new command run.",
                    "正在等待 backend 命令目录返回。返回之后，选择一张卡片就能启动新的命令运行。",
                  )}
                </p>
              </CardContent>
            </Card>
            {loadingSkeletonIds.map((id) => (
              <Card
                key={id}
                as="article"
                className="command-card command-card-skeleton"
                aria-hidden="true"
              >
                <CardContent>
                  <div className="skeleton-line skeleton-line-title" />
                  <div className="skeleton-row">
                    <span className="skeleton-chip" />
                    <span className="skeleton-chip skeleton-chip-short" />
                  </div>
                  <div className="skeleton-line" />
                  <div className="skeleton-line skeleton-line-mid" />
                  <div className="skeleton-row skeleton-footer">
                    <span className="skeleton-line skeleton-line-short" />
                    <span className="skeleton-btn" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </>
        )}
        {commandState === "error" && (
          <Card className="loading-card" role="alert" aria-live="assertive" aria-atomic="true">
            <p className="error-text">{feedbackText}</p>
          </Card>
        )}
        {commandState === "empty" && (
          <div className="empty-state grid-full">
            <div className="empty-state-icon">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M12 9v4M12 17h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="empty-state-title">
              {pickUiText(locale, "No lab commands available", "当前没有可用实验命令")}
            </p>
            <p className="empty-state-desc">
              {pickUiText(
                locale,
                "The lab command catalog came back empty. Check the service and command registry, then refresh to see whether the experiment entrypoints are ready.",
                "实验命令目录返回为空。请先检查服务和命令注册表，再刷新看看实验入口是否已就绪。",
              )}
            </p>
          </div>
        )}
        {commandState === "success" && filteredCommands.length === 0 && (
          <div className="empty-state grid-full">
            <p className="empty-state-title">
              {pickUiText(locale, "No commands in this category yet", "这个分类里还没有命令")}
            </p>
            <p className="empty-state-desc">
              {pickUiText(
                locale,
                "Try All to browse the full catalog, or switch categories to find a different launch path.",
                "可以切回“全部”查看完整目录，或切换其他分类寻找不同启动路径。",
              )}
            </p>
          </div>
        )}
        {commandState === "success" &&
          filteredCommands.map((command) => {
            const category = guessCategory(command);
            const isRunning = submittingId === command.command_id;
            const dangerous = isDangerous(command);
            const ai = isAiCommand(command);
            return (
              <Card key={command.command_id} as="article" className="command-card">
                <CardHeader>
                  <h2 className="command-title">{command.title}</h2>
                  <div className="command-tags">
                    <Badge className="chip" variant="secondary">
                      {localizeCategoryLabel(category)}
                    </Badge>
                    <Badge className="chip" variant="outline">
                      {command.command_id}
                    </Badge>
                    {ai && (
                      <Badge className="chip ai" variant="secondary">
                        {"AI"}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="command-desc">{command.description}</p>
                </CardContent>
                <CardFooter className="command-footer">
                  <span className="command-tags-text">
                    {command.tags.length > 0 ? command.tags.join(" / ") : ""}
                  </span>
                  <Button
                    size="sm"
                    variant={dangerous ? "destructive" : "default"}
                    loading={isRunning}
                    onClick={() => onRunCommand(command)}
                    data-testid="commandgrid-run-command"
                  >
                    {isRunning
                      ? pickUiText(locale, "Running...", "运行中...")
                      : dangerous
                        ? pickUiText(locale, "Dangerous run", "危险运行")
                        : pickUiText(locale, "Run", "运行")}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
      </div>
    </>
  );
}

export default memo(CommandGrid);
