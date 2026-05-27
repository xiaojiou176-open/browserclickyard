import type { ReactNode } from "react";
import { memo } from "react";

export interface DetailFieldItem {
  label: string;
  value: ReactNode;
}

interface DetailFieldRowProps {
  fields: ReadonlyArray<DetailFieldItem | null | undefined | false>;
}

function DetailFieldRow({ fields }: DetailFieldRowProps) {
  const visibleFields = fields.filter((field): field is DetailFieldItem => Boolean(field));
  return (
    <div className="form-row">
      {visibleFields.map((field, index) => (
        <div className="field" key={`${field.label}-${index}`}>
          <span className="field-label">{field.label}</span>
          <span className="text-sm">{field.value}</span>
        </div>
      ))}
    </div>
  );
}

export default memo(DetailFieldRow);
