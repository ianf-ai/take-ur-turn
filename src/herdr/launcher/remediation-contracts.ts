/** Recovery evidence shared by delivery and remediation; no implementation dependencies. */
export interface RemediationEvidence {
  strategy: string;
  action: 'none' | 'machine-enter';
  result: 'skipped' | 'attempting' | 'working-observed' | 'give-up';
  enter_transport: 'not-attempted' | 'sent' | 'not-sent' | 'uncertain';
  status_flip: boolean;
  attribution: 'machine-remediation' | 'unavailable';
  reason: string;
  /** Accepted staging evidence; a viewport match alone never authorizes input. */
  staged_basis?: string;
  reevaluated?: true;
}
