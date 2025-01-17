/**
 * Exported functions for the Worker to interact with the Workflow isolate
 *
 * @module
 */
import ivm from 'isolated-vm';
import {
  IllegalStateError,
  msToTs,
  tsToMs,
  composeInterceptors,
  Workflow,
  ApplicationFailure,
  errorMessage,
} from '@temporalio/common';
import { coresdk } from '@temporalio/proto/lib/coresdk';
import { WorkflowInfo } from './interfaces';
import { consumeCompletion, handleWorkflowFailure, state } from './internals';
import { alea } from './alea';
import { IsolateExtension, HookManager } from './promise-hooks';
import { DeterminismViolationError } from './errors';
import { ApplyMode, ExternalDependencyFunction, ExternalCall } from './dependencies';
import { WorkflowInterceptorsFactory } from './interceptors';

export function setRequireFunc(fn: Exclude<typeof state['require'], undefined>): void {
  state.require = fn;
}

export function overrideGlobals(): void {
  const global = globalThis as any;
  // Mock any weak reference holding structures because GC is non-deterministic.
  // WeakRef is implemented in V8 8.4 which is embedded in node >=14.6.0.
  // Workflow developer will get a meaningful exception if they try to use these.
  global.WeakMap = function () {
    throw new DeterminismViolationError('WeakMap cannot be used in workflows because v8 GC is non-deterministic');
  };
  global.WeakSet = function () {
    throw new DeterminismViolationError('WeakSet cannot be used in workflows because v8 GC is non-deterministic');
  };
  global.WeakRef = function () {
    throw new DeterminismViolationError('WeakRef cannot be used in workflows because v8 GC is non-deterministic');
  };

  const OriginalDate = globalThis.Date;

  global.Date = function (...args: unknown[]) {
    if (args.length > 0) {
      return new (OriginalDate as any)(...args);
    }
    return new OriginalDate(state.now);
  };

  global.Date.now = function () {
    return state.now;
  };

  global.Date.parse = OriginalDate.parse.bind(OriginalDate);
  global.Date.UTC = OriginalDate.UTC.bind(OriginalDate);

  global.Date.prototype = OriginalDate.prototype;

  global.setTimeout = function (cb: (...args: any[]) => any, ms: number, ...args: any[]): number {
    const seq = state.nextSeqs.timer++;
    state.completions.timer.set(seq, {
      resolve: () => cb(...args),
      reject: () => undefined /* ignore cancellation */,
    });
    state.pushCommand({
      startTimer: {
        seq,
        startToFireTimeout: msToTs(ms),
      },
    });
    return seq;
  };

  global.clearTimeout = function (handle: number): void {
    state.nextSeqs.timer++;
    state.completions.timer.delete(handle);
    state.pushCommand({
      cancelTimer: {
        seq: handle,
      },
    });
  };

  // state.random is mutable, don't hardcode its reference
  Math.random = () => state.random();
}

/**
 * Initialize the isolate runtime.
 *
 * Sets required internal state and instantiates the workflow and interceptors.
 */
export async function initRuntime(
  info: WorkflowInfo,
  interceptorModules: string[],
  randomnessSeed: number[],
  now: number,
  isolateExtension: IsolateExtension
): Promise<void> {
  // Globals are overridden while building the isolate before loading user code.
  // For some reason the `WeakRef` mock is not restored properly when creating an isolate from snapshot in node 14 (at least on ubuntu), override again.
  (globalThis as any).WeakRef = function () {
    throw new DeterminismViolationError('WeakRef cannot be used in workflows because v8 GC is non-deterministic');
  };
  state.info = info;
  state.now = now;
  state.random = alea(randomnessSeed);
  HookManager.instance.setIsolateExtension(isolateExtension);

  const { require: req } = state;
  if (req === undefined) {
    throw new IllegalStateError('Workflow has not been initialized');
  }

  for (const mod of interceptorModules) {
    const factory: WorkflowInterceptorsFactory = req(mod).interceptors;
    if (factory !== undefined) {
      if (typeof factory !== 'function') {
        throw new TypeError(`interceptors must be a function, got: ${factory}`);
      }
      const interceptors = factory();
      state.interceptors.inbound.push(...(interceptors.inbound ?? []));
      state.interceptors.outbound.push(...(interceptors.outbound ?? []));
      state.interceptors.internals.push(...(interceptors.internals ?? []));
    }
  }

  let mod: Workflow;
  try {
    mod = req(undefined)[info.workflowType];
    if (typeof mod !== 'function') {
      throw new TypeError(`'${info.workflowType}' is not a function`);
    }
  } catch (err) {
    const failure = ApplicationFailure.nonRetryable(errorMessage(err), 'ReferenceError');
    failure.stack = failure.stack?.split('\n')[0];
    handleWorkflowFailure(failure);
    return;
  }
  state.workflow = mod;
}

export interface ActivationResult {
  externalCalls: ExternalCall[];
  numBlockedConditions: number;
}

/**
 * Run a chunk of activation jobs
 * @returns a boolean indicating whether job was processed or ignored
 */
export async function activate(encodedActivation: Uint8Array, batchIndex: number): Promise<ActivationResult> {
  const activation = coresdk.workflow_activation.WFActivation.decodeDelimited(encodedActivation);
  const intercept = composeInterceptors(
    state.interceptors.internals,
    'activate',
    async ({ activation, batchIndex }) => {
      if (batchIndex === 0) {
        if (state.info === undefined) {
          throw new IllegalStateError('Workflow has not been initialized');
        }
        if (!activation.jobs) {
          throw new TypeError('Got activation with no jobs');
        }
        if (activation.timestamp !== null) {
          // timestamp will not be updated for activation that contain only queries
          state.now = tsToMs(activation.timestamp);
        }
        state.info.isReplaying = activation.isReplaying ?? false;
      }

      // Cast from the interface to the class which has the `variant` attribute.
      // This is safe because we just decoded this activation from a buffer.
      const jobs = activation.jobs as coresdk.workflow_activation.WFActivationJob[];

      await Promise.all(
        jobs.map(async (job) => {
          if (job.variant === undefined) {
            throw new TypeError('Expected job.variant to be defined');
          }
          const variant = job[job.variant];
          if (!variant) {
            throw new TypeError(`Expected job.${job.variant} to be set`);
          }
          // The only job that can be executed on a completed workflow is a query.
          // We might get other jobs after completion for instance when a single
          // activation contains multiple jobs and the first one completes the workflow.
          if (state.completed && job.variant !== 'queryWorkflow') {
            return;
          }
          await state.activator[job.variant](variant as any /* TODO: TS is struggling with `true` and `{}` */);
          tryUnblockConditions();
        })
      );
    }
  );
  await intercept({
    activation,
    batchIndex,
  });

  return {
    externalCalls: state.getAndResetPendingExternalCalls(),
    numBlockedConditions: state.blockedConditions.size,
  };
}

type ActivationConclusion =
  | { type: 'pending'; pendingExternalCalls: ExternalCall[]; numBlockedConditions: number }
  | { type: 'complete'; encoded: Uint8Array };

/**
 * Conclude a single activation.
 * Should be called after processing all activation jobs and queued microtasks.
 *
 * Activation may be in either `complete` or `pending` state according to pending external dependency calls.
 * Activation failures are handled in the main Node.js isolate.
 */
export function concludeActivation(): ActivationConclusion {
  const pendingExternalCalls = state.getAndResetPendingExternalCalls();
  if (pendingExternalCalls.length > 0) {
    return { type: 'pending', pendingExternalCalls, numBlockedConditions: state.blockedConditions.size };
  }
  const intercept = composeInterceptors(state.interceptors.internals, 'concludeActivation', (input) => input);
  const { info } = state;
  const { commands } = intercept({ commands: state.commands });
  const encoded = coresdk.workflow_completion.WFActivationCompletion.encodeDelimited({
    runId: info?.runId,
    successful: { commands },
  }).finish();
  state.commands = [];
  return { type: 'complete', encoded };
}

export function getAndResetPendingExternalCalls(): ExternalCall[] {
  return state.getAndResetPendingExternalCalls();
}

/**
 * Inject an external dependency function into the Workflow via global state.
 * The injected function is available via {@link dependencies}.
 */
export function inject(
  ifaceName: string,
  fnName: string,
  dependency: ivm.Reference<ExternalDependencyFunction>,
  applyMode: ApplyMode,
  transferOptions: ivm.TransferOptionsBidirectional
): void {
  if (state.dependencies[ifaceName] === undefined) {
    state.dependencies[ifaceName] = {};
  }
  if (applyMode === ApplyMode.ASYNC) {
    state.dependencies[ifaceName][fnName] = (...args: any[]) =>
      new Promise((resolve, reject) => {
        const seq = state.nextSeqs.dependency++;
        state.completions.dependency.set(seq, {
          resolve,
          reject,
        });
        state.pendingExternalCalls.push({ ifaceName, fnName, args, seq });
      });
  } else if (applyMode === ApplyMode.ASYNC_IGNORED) {
    state.dependencies[ifaceName][fnName] = (...args: any[]) =>
      state.pendingExternalCalls.push({ ifaceName, fnName, args });
  } else {
    state.dependencies[ifaceName][fnName] = (...args: any[]) => dependency[applyMode](undefined, args, transferOptions);
  }
}

export interface ExternalDependencyResult {
  seq: number;
  result: any;
  error: any;
}

/**
 * Resolve external dependency function calls with given results.
 */
export function resolveExternalDependencies(results: ExternalDependencyResult[]): void {
  for (const { seq, result, error } of results) {
    const completion = consumeCompletion('dependency', seq);
    if (error) {
      completion.reject(error);
    } else {
      completion.resolve(result);
    }
  }
}

/**
 * Loop through all blocked conditions, evaluate and unblock if possible.
 *
 * @returns number of unblocked conditions.
 */
export function tryUnblockConditions(): number {
  let numUnblocked = 0;
  for (;;) {
    const prevUnblocked = numUnblocked;
    for (const [seq, cond] of state.blockedConditions.entries()) {
      if (cond.fn()) {
        cond.resolve();
        numUnblocked++;
        // It is safe to delete elements during map iteration
        state.blockedConditions.delete(seq);
      }
    }
    if (prevUnblocked === numUnblocked) {
      break;
    }
  }
  return numUnblocked;
}
