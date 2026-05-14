import type { ResourceKey } from "./resource";

export type ProgramInputKind = "action" | "ui" | "resource" | "system";

export type ActionProgramInput<TMessage extends { type: string }> = {
  kind: "action";
  message: TMessage;
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
      sessionId: string;
      cursor: string;
    };

export type ProgramInput<
  TActionMessage extends { type: string },
  TUIEvent extends { type: string },
> =
  | ActionProgramInput<TActionMessage>
  | UIProgramInput<TUIEvent>
  | ResourceProgramInput
  | SystemProgramInput;
