import type { JsonValue } from "./json";

export type SerializedResourceKey = {
  type: string;
  id: string;
  label: string;
  scope?: {
    kind: string;
    id: string;
    label: string;
  };
};

export type ProjectionRegionSnapshot = {
  id: string;
  value?: JsonValue;
  resources: SerializedResourceKey[];
};

export type ResourceObservation = {
  key: SerializedResourceKey;
};
