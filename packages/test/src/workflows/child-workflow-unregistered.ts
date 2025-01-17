import { createChildWorkflowHandle, WorkflowInfo, workflowInfo } from '@temporalio/workflow';

async function unregisteredWorkflow(): Promise<void> {
  // noop
}

let info: WorkflowInfo | undefined;
try {
  info = workflowInfo();
} catch (err) {
  // Ignore if not in Workflow context
}

if (info !== undefined) {
  try {
    // Running in Workflow context
    createChildWorkflowHandle(unregisteredWorkflow, { workflowId: 'wid' });
    throw new Error('Managed to create a workflow handle for an unregistered Workflow');
  } catch (err) {
    if (!(err instanceof TypeError)) {
      throw err;
    }
  }
}
