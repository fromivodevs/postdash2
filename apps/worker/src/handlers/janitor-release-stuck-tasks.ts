/**
 * Handler: janitor_release_stuck_tasks.
 *
 * Periodic reset of tasks whose lease expired (worker crashed mid-execute).
 * Counter for observability is emitted as a log line.
 *
 * See packages/tasks/src/queue.ts → `releaseStuckTasks` for the SQL.
 */

import { releaseStuckTasks } from '@postdash/tasks';
import type { TaskHandler } from '../dispatcher.js';

export const janitorReleaseStuckTasksHandler: TaskHandler = async (_task, ctx) => {
  const count = await releaseStuckTasks(ctx.client);
  if (count > 0) {
    ctx.logger.warn({ count }, 'janitor released stuck tasks');
  } else {
    ctx.logger.debug('janitor: no stuck tasks');
  }
};
