import { defaultKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as placeholderExtension } from "@codemirror/view";
import { useEffect, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

import { useRoom } from "@/lib/room-context";

/**
 * A CodeMirror editor bound to a shared Y.Text: everyone in the room types
 * into the same text and sees each other's carets and selections
 * (`y-codemirror.next` reads them from the room's awareness).
 */
export function CollabEditor({
  text,
  readOnly,
  placeholder,
  onSubmit,
  keys,
  className,
}: {
  text: Y.Text;
  readOnly: boolean;
  placeholder?: string;
  /** ⌘/Ctrl+Enter. */
  onSubmit?: () => void;
  /** More key bindings (CodeMirror key names), fixed when the editor is made. */
  keys?: Record<string, () => void>;
  className?: string;
}) {
  const room = useRoom();
  const host = useRef<HTMLDivElement>(null);
  const submit = useRef(onSubmit);
  const extra = useRef(keys);
  useEffect(() => {
    submit.current = onSubmit;
    extra.current = keys;
  });

  useEffect(() => {
    if (!host.current) return;
    const undoManager = new Y.UndoManager(text);
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          Prec.highest(
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  submit.current?.();
                  return true;
                },
              },
              ...Object.keys(extra.current ?? {}).map((key) => ({
                key,
                run: () => {
                  extra.current?.[key]?.();
                  return true;
                },
              })),
            ]),
          ),
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
          markdown(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          placeholder ? placeholderExtension(placeholder) : [],
          yCollab(text, room.awareness, { undoManager }),
          EditorView.theme({
            "&": { fontSize: "13px", backgroundColor: "transparent", height: "100%" },
            "&.cm-focused": { outline: "none" },
            ".cm-scroller": { fontFamily: "var(--font-sans)", lineHeight: "1.55" },
            ".cm-content": { padding: "8px 0", caretColor: "var(--foreground)" },
            ".cm-line": { padding: "0 10px" },
            ".cm-placeholder": { color: "var(--muted-foreground)" },
            ".cm-ySelectionInfo": {
              fontFamily: "var(--font-sans)",
              fontSize: "10px",
              fontWeight: "600",
              opacity: "1",
              top: "-1.25em",
              padding: "0 4px",
              borderRadius: "3px",
              color: "oklch(0.2 0 0)",
            },
          }),
        ],
      }),
    });
    return () => {
      view.destroy();
      undoManager.destroy();
    };
  }, [text, readOnly, placeholder, room.awareness]);

  return <div ref={host} className={className} />;
}
