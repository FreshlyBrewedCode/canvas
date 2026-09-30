import { Check, ChevronDown, LoaderCircle, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { modeOption, modeTone, nextMode } from "@/lib/agent-mode";
import { cn } from "@/lib/utils";
import type { AgentConfigOption, AgentConfigValue, AgentSetting } from "../../shared/protocol";

/** Where each kind of setting goes in the popover; unknown categories last. */
const ORDER = ["model", "thought_level", "model_config", "mode"];
const rank = (category: string | undefined) => {
  const index = ORDER.indexOf(category ?? "");
  return index === -1 ? ORDER.length : index;
};

/** Longer lists than this get a search box instead of buttons. */
const SEGMENTED_MAX = 8;

/**
 * The composer's settings control: a chip with the current model (and
 * reasoning level), opening every setting the agent offers. The agent decides
 * what exists, so this renders whatever options it listed.
 */
export function AgentSettings({
  settings,
  options,
  known,
  disabled,
  onChange,
}: {
  /** Last reported values — shown while the agent is not connected. */
  settings: ReadonlyArray<AgentSetting> | undefined;
  options: ReadonlyArray<AgentConfigOption> | undefined;
  /** The session is known here; until then nothing says whether its agent is starting. */
  known: boolean;
  disabled: boolean;
  onChange: (configId: string, value: AgentConfigValue) => Promise<void>;
}) {
  const [requested, setRequested] = useState<{
    id: string;
    value: AgentConfigValue;
    /** The options when asked: the agent's answer replaces them. */
    before: typeof options;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A change is done once the agent reports back — whatever it reports.
  const pending = requested && requested.before === options ? requested : null;
  useEffect(() => {
    if (!requested) return;
    const timer = setTimeout(() => setRequested(null), 15_000);
    return () => clearTimeout(timer);
  }, [requested]);

  const change = (id: string, value: AgentConfigValue) => {
    setError(null);
    setRequested({ id, value, before: options });
    onChange(id, value).catch((cause: unknown) => {
      setRequested(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const current = settings ?? [];
  const model = current.find((s) => s.category === "model");
  const thought = current.find((s) => s.category === "thought_level");
  const sorted = [...(options ?? [])].sort((a, b) => rank(a.category) - rank(b.category));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-agent-settings=""
          className="hover:bg-accent text-muted-foreground hover:text-foreground flex max-w-56 min-w-0 items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[11px]"
          title="Agent settings"
        >
          {model ? (
            <span className="truncate">
              <span className="text-foreground">{model.label}</span>
              {thought && thought.value !== "default" && ` · ${thought.label}`}
            </span>
          ) : options ? (
            <span className="truncate">settings</span>
          ) : (
            <>
              <LoaderCircle className="size-3 animate-spin" />{" "}
              {known ? "starting agent…" : "loading…"}
            </>
          )}
          {pending ? (
            <LoaderCircle className="size-3 shrink-0 animate-spin" />
          ) : (
            <ChevronDown className="size-3 shrink-0" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" data-agent-settings-popover="">
        {!options ? (
          <p className="text-muted-foreground flex items-center gap-2 p-3 text-xs">
            <LoaderCircle className="size-3.5 animate-spin" />
            {known ? "Starting the agent to list its settings…" : "Loading the agent's settings…"}
          </p>
        ) : sorted.length === 0 ? (
          <p className="text-muted-foreground p-3 text-xs">This agent offers no settings.</p>
        ) : (
          <div className="divide-y">
            {sorted.map((option) => (
              <Setting
                key={option.id}
                option={option}
                disabled={disabled}
                pending={pending?.id === option.id ? pending.value : undefined}
                onChange={(value) => change(option.id, value)}
              />
            ))}
          </div>
        )}
        {error && <p className="text-destructive border-t px-3 py-2 text-xs">{error}</p>}
      </PopoverContent>
    </Popover>
  );
}

function Setting({
  option,
  disabled,
  pending,
  onChange,
}: {
  option: AgentConfigOption;
  disabled: boolean;
  pending: AgentConfigValue | undefined;
  onChange: (value: AgentConfigValue) => void;
}) {
  const choices =
    option.type === "boolean"
      ? [
          { value: "on", name: "On" },
          { value: "off", name: "Off" },
        ]
      : option.choices;
  const toValue = (value: string): AgentConfigValue =>
    option.type === "boolean" ? value === "on" : value;
  const fromValue = (value: AgentConfigValue | undefined) =>
    typeof value === "boolean" ? (value ? "on" : "off") : value;

  return (
    <section className="space-y-1.5 p-3" data-setting={option.id}>
      <h3
        className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase"
        title={option.description}
      >
        {option.name}
      </h3>
      {option.category === "model" || choices.length > SEGMENTED_MAX ? (
        <SearchList
          choices={choices}
          value={fromValue(option.value)!}
          pending={fromValue(pending)}
          disabled={disabled}
          onPick={(value) => onChange(toValue(value))}
        />
      ) : (
        <div className="flex flex-wrap gap-1">
          {choices.map((choice) => {
            const selected = fromValue(option.value) === choice.value;
            return (
              <button
                key={choice.value}
                type="button"
                disabled={disabled}
                title={"description" in choice ? choice.description : undefined}
                aria-pressed={selected}
                className={cn(
                  "flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50",
                  selected
                    ? "border-primary bg-primary text-primary-foreground"
                    : "hover:bg-accent bg-background",
                )}
                onClick={() => !selected && onChange(toValue(choice.value))}
              >
                {fromValue(pending) === choice.value && (
                  <LoaderCircle className="size-3 animate-spin" />
                )}
                {choice.name}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SearchList({
  choices,
  value,
  pending,
  disabled,
  onPick,
}: {
  choices: AgentConfigOption["choices"];
  value: string;
  pending: string | undefined;
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return choices.filter((choice) => {
      const haystack =
        `${choice.name} ${choice.value} ${choice.description ?? ""} ${choice.group ?? ""}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    });
  }, [choices, query]);

  return (
    <div className="space-y-1.5">
      {choices.length > SEGMENTED_MAX && (
        <label className="bg-muted/60 flex items-center gap-1.5 rounded-md px-2 py-1">
          <Search className="text-muted-foreground size-3.5" />
          <input
            aria-label="Search"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none"
            placeholder={`Search ${choices.length} models…`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && matches[0] && !disabled) onPick(matches[0].value);
            }}
          />
        </label>
      )}
      <div className="-mx-1 max-h-60 overflow-y-auto">
        {matches.length === 0 && (
          <p className="text-muted-foreground px-1 py-2 text-xs">No match.</p>
        )}
        {matches.slice(0, 200).map((choice, index) => {
          const selected = choice.value === value;
          const heading = choice.group && choice.group !== matches[index - 1]?.group;
          return (
            <div key={choice.value}>
              {heading && (
                <p className="text-muted-foreground px-1 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide uppercase">
                  {choice.group}
                </p>
              )}
              <button
                type="button"
                data-choice={choice.value}
                aria-pressed={selected}
                disabled={disabled}
                className="hover:bg-accent flex w-full items-start gap-1.5 rounded-md px-1 py-1 text-left disabled:opacity-50"
                onClick={() => !selected && onPick(choice.value)}
              >
                <span className="mt-0.5 size-3.5 shrink-0">
                  {pending === choice.value ? (
                    <LoaderCircle className="size-3.5 animate-spin" />
                  ) : (
                    selected && <Check className="size-3.5" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs">{choice.name}</span>
                  {choice.description && (
                    <span className="text-muted-foreground block text-[11px] leading-snug">
                      {choice.description}
                    </span>
                  )}
                </span>
              </button>
            </div>
          );
        })}
        {matches.length > 200 && (
          <p className="text-muted-foreground px-1 py-1 text-[11px]">
            {matches.length - 200} more — refine the search.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Going to the agent's next mode. `canvas serve` sends the options back after
 * every change asked for, so new options are the agent's answer: still in the
 * old mode, it refused the new one (Claude Code's Auto, on models without it).
 */
export function useModeCycle(
  options: ReadonlyArray<AgentConfigOption> | undefined,
  onChange: (configId: string, value: AgentConfigValue) => Promise<void>,
) {
  const [requested, setRequested] = useState<{ value: string; before: typeof options } | null>(
    null,
  );
  /** Modes the agent answered without going to: not offered again. */
  const [refused, setRefused] = useState<ReadonlySet<string>>(new Set());
  const option = modeOption(options);

  // The answer came: settle it while rendering (React's "adjusting state on a prop change").
  if (requested && requested.before !== options) {
    if (option?.value !== requested.value) setRefused(new Set(refused).add(requested.value));
    setRequested(null);
  }
  useEffect(() => {
    if (!requested) return;
    const timer = setTimeout(() => setRequested(null), 15_000);
    return () => clearTimeout(timer);
  }, [requested]);

  const next = option ? nextMode(option, refused) : null;
  const pending = !!requested;
  const cycle = () => {
    if (!option || !next || pending) return;
    setRequested({ value: next, before: options });
    onChange(option.id, next).catch(() => setRequested(null));
  };
  return { option, next, pending, cycle };
}

/**
 * The agent's mode, beside the settings chip: quiet in the default mode,
 * coloured in any other. A click (or Shift+Tab in the composer) goes to the
 * next mode; modes that skip permissions are only picked in the settings.
 */
export function ModeChip({
  settings,
  mode,
  disabled,
}: {
  settings: ReadonlyArray<AgentSetting> | undefined;
  mode: ReturnType<typeof useModeCycle>;
  disabled: boolean;
}) {
  const { option, next, pending, cycle } = mode;
  const known = settings?.find((setting) => setting.category === "mode");
  if (!option && !known) return null;
  const label = option?.choices.find((c) => c.value === option.value)?.name ?? known?.label;
  const tone = option ? modeTone(option) : "default";
  const nextName = next && option?.choices.find((c) => c.value === next)?.name;

  return (
    <button
      type="button"
      data-mode-chip={option?.value ?? known?.value}
      data-mode-tone={tone}
      disabled={disabled || !next || pending}
      title={nextName ? `Mode: ${label}. Click or Shift+Tab: ${nextName}` : `Mode: ${label}`}
      className={cn(
        "flex max-w-32 min-w-0 shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] disabled:cursor-default",
        tone === "default" && "text-muted-foreground hover:text-foreground border-transparent",
        tone === "plan" && "border-status-pending/45 bg-status-pending/10 text-status-pending",
        tone === "other" && "border-status-ready/45 bg-status-ready/10 text-status-ready",
        tone === "risky" && "border-status-blocked/45 bg-status-blocked/10 text-status-blocked",
      )}
      onClick={cycle}
    >
      {pending && <LoaderCircle className="size-3 shrink-0 animate-spin" />}
      <span className="truncate">{label}</span>
    </button>
  );
}
