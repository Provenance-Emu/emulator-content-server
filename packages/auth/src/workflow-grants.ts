export interface WorkflowPrincipal {
  kind: 'workflow-host';
  hostId: string;
  ownerId: string;
}
export function workflowGrantAllows(
  principal: WorkflowPrincipal,
  action: string,
  resource?: { hostId: string },
): boolean {
  if (principal.kind !== 'workflow-host') return false;
  if (['claim', 'advertise'].includes(action)) return true;
  return (
    ['heartbeat', 'publish', 'read-work'].includes(action) && resource?.hostId === principal.hostId
  );
}
