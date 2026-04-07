import { memo } from "react";

type StreamLog = {
  ts: string;
  level: string;
  message: string;
};

interface LogStreamProps {
  logs: StreamLog[];
  maxHeight?: string;
}

function LogStream({ logs, maxHeight = "200px" }: LogStreamProps) {
  return (
    <div className="terminal-body" style={{ maxHeight, borderRadius: "var(--radius)" }}>
      {logs.map((log, index) => (
        <span key={`${log.ts}-${index}`} className="log-line">
          <span className="log-time">{new Date(log.ts).toLocaleTimeString()}</span>{" "}
          <span className={`log-tag ${log.level}`}>[{log.level.toUpperCase()}]</span> {log.message}
          {"\n"}
        </span>
      ))}
    </div>
  );
}

export default memo(LogStream);
