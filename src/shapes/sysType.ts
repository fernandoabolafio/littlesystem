import type { TLShape } from "tldraw";
import type { NodeKind } from "../sim/engine";

export const SYS_TYPE = "sys";

declare module "tldraw" {
  export interface TLGlobalShapePropsMap {
    [SYS_TYPE]: {
      w: number;
      h: number;
      kind: NodeKind;
      name: string;
      code: string;
      view: string;
    };
  }
}

export type SysShape = TLShape<typeof SYS_TYPE>;
