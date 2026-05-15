import type { ResourceKey } from "./resource";

export type ProgramInputKind = "action" | "ui" | "resource" | "system";

export type ActionProgramInput<TInput extends { type: string }> = {
  kind: "action";
  input: TInput;
};

export type UIProgramInput<TEvent extends { type: string }> = {
  kind: "ui";
  event: TEvent;
};

export type ResourceProgramInput = {
  kind: "resource";
  event: ResourceEvent;
};

export type SystemProgramInput = {
  kind: "system";
  event: SystemEvent;
};

export type ResourceEvent = {
  type: "resource.invalidate";
  keys: ResourceKey[];
};

export type SystemEvent =
  | {
      type: "system.connect";
      route: string;
      params: Record<string, string>;
    }
  | {
      type: "system.resume";
      viewId: string;
      cursor: string;
    }
  | {
      type: "system.navigate";
      path: string;
      params?: Record<string, string>;
      navigation?: "push" | "replace" | "pop" | "hash";
    };

export type ProgramInput<
  TActionInput extends { type: string },
  TUIEvent extends { type: string },
> =
  | ActionProgramInput<TActionInput>
  | UIProgramInput<TUIEvent>
  | ResourceProgramInput
  | SystemProgramInput;
