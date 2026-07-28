import type { Transferable } from "node:worker_threads";

declare module "worker_threads" {
  /** Compatibility alias for thread-stream 4.2 until its Node 26 types update. */
  type TransferListItem = Transferable;
}
