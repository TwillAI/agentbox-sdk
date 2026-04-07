export interface RawAgentEvent<TPayload = unknown> {
  provider: string;
  runId: string;
  type: string;
  timestamp: string;
  payload: TPayload;
}
