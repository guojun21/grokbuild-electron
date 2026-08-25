export const UPDATE_OPERATIONS = Object.freeze(['app', 'cli'] as const)

export type UpdateOperation = (typeof UPDATE_OPERATIONS)[number]

export type UpdateOperationSnapshot =
  | { busy: false }
  | { busy: true; operation: UpdateOperation }

interface UpdateOperationOwner {
  id: symbol
  operation: UpdateOperation
}

/** Opaque, idempotent ownership used when an operation spans process quit. */
export interface UpdateOperationLease {
  release(): void
}

/** Fixed, content-free contention error safe to map across a renderer boundary. */
export class UpdateOperationBusyError extends Error {
  readonly code = 'update-operation-busy'

  constructor() {
    super('Another update operation is already in progress.')
    this.name = 'UpdateOperationBusyError'
  }
}

/**
 * Main-only mutual exclusion shared by app and Grok CLI update orchestration.
 *
 * Calls never deduplicate or re-enter: every contender while an owner exists
 * receives UpdateOperationBusyError. Ownership uses an opaque per-acquisition
 * token, so a stale or repeated release cannot clear a newer acquisition.
 */
export class UpdateOperationLock {
  private owner: UpdateOperationOwner | null = null

  snapshot(): UpdateOperationSnapshot {
    const owner = this.owner
    return owner
      ? Object.freeze({ busy: true, operation: owner.operation })
      : Object.freeze({ busy: false })
  }

  acquire(operation: UpdateOperation): UpdateOperationLease {
    if (!isUpdateOperation(operation)) {
      throw new TypeError('Unsupported update operation.')
    }
    if (this.owner) {
      throw new UpdateOperationBusyError()
    }

    const owner: UpdateOperationOwner = {
      id: Symbol('update-operation-owner'),
      operation
    }
    this.owner = owner
    let released = false
    return Object.freeze({
      release: () => {
        if (released) return
        released = true
        this.release(owner.id)
      }
    })
  }

  async runExclusive<T>(operation: UpdateOperation, fn: () => T | PromiseLike<T>): Promise<T> {
    const lease = this.acquire(operation)

    try {
      return await fn()
    } finally {
      lease.release()
    }
  }

  private release(ownerId: symbol): void {
    if (this.owner?.id !== ownerId) return
    this.owner = null
  }
}

function isUpdateOperation(value: unknown): value is UpdateOperation {
  return value === 'app' || value === 'cli'
}
