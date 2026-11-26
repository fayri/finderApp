"use client";

import { useRef, useState } from "react";
import { Check, ChevronDown, FileSpreadsheet, FileText, Upload, X } from "lucide-react";
import type { ParsedSource } from "@/lib/types";

interface UploadPanelProps {
  source: ParsedSource | null;
  isParsing: boolean;
  disabled: boolean;
  onFile: (file: File) => void;
  onColumnChange: (index: number) => void;
  onClear: () => void;
}

export function UploadPanel({
  source,
  isParsing,
  disabled,
  onFile,
  onColumnChange,
  onClear,
}: UploadPanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  function acceptFile(fileList: FileList | null) {
    const file = fileList?.item(0);
    if (file) onFile(file);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <section className="upload-section" aria-labelledby="upload-heading">
      <div className="upload-heading-row">
        <div>
          <p className="section-kicker">01 / Your source file</p>
          <h2 id="upload-heading">Upload a product list</h2>
        </div>
        <span className="quiet-tag">CSV or XLSX</span>
      </div>

      {source ? (
        <div className="source-card">
          <div className="source-file-icon" aria-hidden="true">
            {source.fileKind === "xlsx" ? <FileSpreadsheet size={19} /> : <FileText size={19} />}
          </div>
          <div className="source-file-copy">
            <strong title={source.fileName}>{source.fileName}</strong>
            <span>
              {source.rows.length} data {source.rows.length === 1 ? "row" : "rows"}
              {source.headerRowNumber ? ` · header on row ${source.headerRowNumber}` : " · no header detected"}
            </span>
          </div>
          <span className="ready-check" aria-label="File ready">
            <Check size={15} />
          </span>
          <button
            className="icon-button remove-file"
            type="button"
            onClick={onClear}
            disabled={disabled}
            aria-label="Remove uploaded file"
            title="Remove file"
          >
            <X size={17} />
          </button>

          <div className="source-column-select">
            <label htmlFor="ean-column">Which column contains the EAN?</label>
            <div className="select-wrap">
              <select
                id="ean-column"
                value={source.eanColumnIndex}
                onChange={(event) => onColumnChange(Number(event.target.value))}
                disabled={disabled}
              >
                {source.headers.map((header, index) => (
                  <option key={`${index}-${header}`} value={index}>
                    {header} · column {index + 1}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} aria-hidden="true" />
            </div>
          </div>
        </div>
      ) : (
        <div
          className={`upload-dropzone${isDragging ? " is-dragging" : ""}${disabled ? " is-disabled" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            if (!disabled) setIsDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            if (!disabled) acceptFile(event.dataTransfer.files);
          }}
        >
          <input
            ref={inputRef}
            id="spreadsheet-file"
            className="visually-hidden"
            type="file"
            accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
            onChange={(event) => acceptFile(event.currentTarget.files)}
            disabled={disabled || isParsing}
          />
          <span className="upload-icon" aria-hidden="true">
            {isParsing ? <span className="spinner" /> : <Upload size={20} />}
          </span>
          <div className="upload-copy">
            <p className="upload-title">{isParsing ? "Reading your file…" : "Drop your file here"}</p>
            <p className="upload-description">or <label htmlFor="spreadsheet-file">browse to upload</label></p>
          </div>
          <span className="upload-format-note">.xlsx or .csv · up to 5 MB</span>
        </div>
      )}

      <p className="privacy-note">
        Files are read in this browser. Only the EAN values you select are sent for lookup.
      </p>
    </section>
  );
}
