/**
 * The frames of the v2 API (docs/specs/t3/T05-v2-api.md) as web2 reads them. The bridge owns them in
 * `shared/v2/contracts.ts`; this module re-exports them so web2 keeps one import path.
 */
export {
  BLOCKING_CODES,
  isBlockingCode,
  isV2ErrorBody,
  V2_COMMAND_PATH,
  V2_REPLAY_LIMIT,
  V2_SHELL_PATH,
  v2HistoryPath,
  v2ThreadPath,
} from "@shared/v2/contracts";
export type {
  BlockingCode,
  CommandReply,
  HistoryPage,
  SequenceFrame,
  ShellSnapshot,
  ThreadSnapshot,
  V2ErrorBody,
  V2ErrorCode,
  V2StreamFrame,
} from "@shared/v2/contracts";
