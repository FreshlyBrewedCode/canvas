import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Copies `text` (or what `get` returns, read at the click). It shows on hover
 * of its `group/copy` (`group/code` for code blocks, inside a message), top right.
 */
export function CopyButton({
  text,
  get,
  title = "Copy",
  group = "copy",
}: {
  text?: string;
  get?: () => string;
  title?: string;
  group?: "copy" | "code";
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      type="button"
      data-copy=""
      title={copied ? "Copied" : title}
      className={cn(
        "bg-card text-muted-foreground hover:text-foreground absolute top-1 right-1 z-10 rounded-md border p-1 opacity-0 shadow-sm transition-opacity focus-visible:opacity-100",
        group === "copy" ? "group-hover/copy:opacity-100" : "group-hover/code:opacity-100",
        copied && "opacity-100",
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => {
        void navigator.clipboard.writeText(get?.() ?? text ?? "").then(() => setCopied(true));
      }}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}
