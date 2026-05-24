/**
 * Job handler for taskSchedule.fire queue.
 *
 * When a schedule fires:
 *   1. Look up the schedule — skip if not 'active', missing, or its host space
 *      is archived/missing.
 *   2. Idempotency check — skip if `schedule.pendingJobId` no longer matches
 *      this job (a previous attempt already advanced the schedule).
 *   3. Atomically: create a SpaceTask, compute the next fire time, enqueue the
 *      next fire job (cron) and write all of `lastCreatedTaskId`, `lastRunAt`,
 *      `nextRunAt`, `pendingJobId`, `status` in one SQLite transaction. If any
 *      step throws, the rollback ensures we never leave a half-fired schedule
 *      (e.g. task created but pendingJobId not advanced) — the queue's retry
 *      will then re-run the handler cleanly.
 *
 * Uses the self-scheduling pattern from github-poll.handler.ts.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { TaskSchedule } from '@neokai/shared';
import { TASK_SCHEDULE_FIRE } from '../job-queue-constants';
import { readSelfNagScheduleScopeId } from '../rpc-handlers';
import { Logger } from '../logger';
import { getNextRunAt } from '../space/schedule/cron-utils';
import type { TaskScheduleRepository } from '../../storage/repositories/task-schedule-repository';
import type { JobQueueRepository, Job } from '../../storage/repositories/job-queue-repository';
import type { SpaceRepository } from '../../storage/repositories/space-repository';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { SpaceGoalService } from '../space/goals/goal-service';
import type { GoalAutomationService } from '../space/goals/goal-automation-service';
import type { SpaceGoalRepository } from '../../storage/repositories/space-goal-repository';

const log = new Logger('task-schedule-fire-handler');

/**
 * Internal sentinel thrown inside the fire transaction when the
 * compare-and-swap on `pending_job_id` fails — i.e. a concurrent
 * pause/delete/reschedule invalidated our claim on this fire. The handler
 * catches this and converts it to a normal `job_superseded` skip; the queue
 * does not retry it.
 */
class ScheduleSupersededError extends Error {
	constructor(scheduleId: string, jobId: string) {
		super(`Schedule ${scheduleId} superseded; job ${jobId} no longer the pending fire`);
		this.name = 'ScheduleSupersededError';
	}
}

export interface TaskScheduleFirePayload extends Record<string, unknown> {
	scheduleId: string;
}

export interface TaskScheduleFireResult extends Record<string, unknown> {
	scheduleId: string;
	taskId: string | null;
	skipped: boolean;
	skipReason?: string;
	nextRunAt: number | null;
}

export interface TaskScheduleFireHandlerDeps {
	db: BunDatabase;
	scheduleRepo: TaskScheduleRepository;
	jobQueue: JobQueueRepository;
	spaceRepo: SpaceRepository;
	taskRepo: SpaceTaskRepository;
	goalService?: SpaceGoalService;
	goalRepo?: SpaceGoalRepository;
	goalAutomationService?: Pick<GoalAutomationService, 'onSelfNag'>;
	/**
	 * Optional event emitter for broadcasting schedule/task changes.
	 * When provided, the handler emits `space.task.created` and
	 * `space.schedule.updated` after a successful fire so the web
	 * client can refresh its state without polling.
	 */
	eventHub?: {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		publish: (event: string, data: any) => Promise<unknown>;
	};
}

export async function handleTaskScheduleFire(
	job: Job,
	deps: TaskScheduleFireHandlerDeps
): Promise<TaskScheduleFireResult> {
	const { scheduleId } = job.payload as TaskScheduleFirePayload;
	const {
		db,
		scheduleRepo,
		jobQueue,
		spaceRepo,
		taskRepo,
		goalService,
		goalRepo,
		goalAutomationService,
		eventHub,
	} = deps;

	const schedule = scheduleRepo.getById(scheduleId);

	// Guard: skip if schedule doesn't exist or is no longer active.
	if (!schedule || schedule.status !== 'active') {
		log.debug('task-schedule-fire: skipping inactive/missing schedule', { scheduleId });
		return {
			scheduleId,
			taskId: null,
			skipped: true,
			skipReason: 'inactive_or_missing',
			nextRunAt: null,
		};
	}

	// Guard: skip if the host space is archived, missing, paused, or stopped.
	// Without this, a non-active space would still spawn fresh tasks every cron
	// tick, violating the space lifecycle contract (paused/stopped must prevent
	// new scheduled work).
	//
	// We don't just bail here: if we leave the schedule with `pendingJobId`
	// pointing at *this* (now-consumed) job, the next cron tick never lands
	// because the schedule has no future job linked. Instead we advance the
	// schedule forward — for cron, we recompute `nextRunAt` and enqueue a fresh
	// fire job; for `at`, we leave the schedule "unwired" by clearing
	// pendingJobId so SpaceManager.resumeSpace/startSpace can recover it. The
	// space-resume path then re-seeds any missed schedules.
	const space = spaceRepo.getSpace(schedule.spaceId);
	if (!space || space.status !== 'active' || space.paused || space.stopped) {
		log.debug('task-schedule-fire: skipping schedule for non-active space', {
			scheduleId,
			spaceId: schedule.spaceId,
			spaceStatus: space?.status,
			paused: space?.paused,
			stopped: space?.stopped,
		});

		// Clear pendingJobId / advance nextRunAt so the space-resume reseed has
		// a clean handle. Do this in a CAS transaction so a concurrent
		// pause/delete/reschedule mid-handler still wins.
		try {
			db.transaction(() => {
				const fresh = scheduleRepo.getById(scheduleId);
				if (!fresh || fresh.status !== 'active') return;
				if (fresh.pendingJobId !== job.id) return; // someone else moved on

				if (fresh.triggerType === 'cron' && fresh.cronExpression) {
					const next = getNextRunAt(fresh.cronExpression, fresh.timezone, Date.now());
					// On cron-config errors (null next), just clear the pending linkage so
					// resume / operator-fix can re-seed; the schedule stays active.
					scheduleRepo.update(scheduleId, { nextRunAt: next ?? undefined });
					scheduleRepo.updatePendingJobId(scheduleId, null);
				} else {
					// `at` schedule — clear pending so resume re-evaluates whether the
					// deadline has passed and either completes or re-enqueues.
					scheduleRepo.updatePendingJobId(scheduleId, null);
				}
			})();
		} catch (err) {
			log.error('task-schedule-fire: clearing pending linkage failed', {
				scheduleId,
				error: err instanceof Error ? err.message : err,
			});
			// Non-fatal — the next space-resume reseed will pick this up.
		}

		return {
			scheduleId,
			taskId: null,
			skipped: true,
			skipReason: 'space_not_active',
			nextRunAt: null,
		};
	}

	// Idempotency fence: if `pendingJobId` no longer matches this job's id, a
	// previous successful attempt already advanced the schedule (and recorded
	// the task) — re-running here would create a duplicate. This catches the
	// case where a transient post-success error caused the queue to retry, or
	// where startup recovery re-seeded a job we ended up running too.
	if (schedule.pendingJobId !== null && schedule.pendingJobId !== job.id) {
		log.debug('task-schedule-fire: skipping — pendingJobId moved past this job', {
			scheduleId,
			jobId: job.id,
			currentPendingJobId: schedule.pendingJobId,
		});
		return {
			scheduleId,
			taskId: schedule.lastCreatedTaskId,
			skipped: true,
			skipReason: 'job_superseded',
			nextRunAt: schedule.nextRunAt,
		};
	}

	const now = Date.now();

	if (schedule.createdByAgent === 'goal-automation-service' && schedule.goalId) {
		return fireGoalAutomationSchedule({
			db,
			job,
			schedule,
			scheduleRepo,
			jobQueue,
			goalRepo,
			goalAutomationService,
			eventHub,
			now,
		});
	}

	// Atomically create the task, compute the next fire, enqueue it, and update
	// the schedule's bookkeeping fields. SpaceTaskRepository.createTask already
	// runs synchronously against `db`, so wrapping the whole sequence in a
	// single SQLite transaction is safe — and crucial: a partial failure (e.g.
	// task inserted but no `lastRunAt` recorded) would otherwise allow the
	// retry to spawn a duplicate task.
	let taskId: string | null = null;
	let nextRunAt: number | null = null;

	try {
		const result = db.transaction(() => {
			let computedNextRunAt: number | null = null;
			let pendingJobId: string | null = null;
			let nextStatus: 'active' | 'completed' = 'completed';

			if (schedule.triggerType === 'cron' && schedule.cronExpression) {
				computedNextRunAt = getNextRunAt(schedule.cronExpression, schedule.timezone, now);

				if (computedNextRunAt !== null) {
					const nextJob = jobQueue.enqueue({
						queue: TASK_SCHEDULE_FIRE,
						payload: { scheduleId } satisfies TaskScheduleFirePayload,
						runAt: computedNextRunAt,
					});
					pendingJobId = nextJob.id;
					nextStatus = 'active';
				}
			}

			if (goalService && schedule.goalId) {
				const claimCheck = goalService.canClaimScheduledTask({
					spaceId: schedule.spaceId,
					goalId: schedule.goalId,
				});
				if (!claimCheck.claimable) {
					const applied = scheduleRepo.updateAfterFireIfPending(scheduleId, job.id, {
						lastCreatedTaskId: schedule.lastCreatedTaskId,
						lastRunAt: now,
						nextRunAt: computedNextRunAt,
						status: nextStatus,
						pendingJobId,
					});
					if (!applied) {
						throw new ScheduleSupersededError(scheduleId, job.id);
					}
					if (claimCheck.goal && computedNextRunAt !== claimCheck.goal.nextCheckInAt) {
						goalService.updateScheduledCheckIn(claimCheck.goal.id, computedNextRunAt);
					}
					return { taskId: null, nextRunAt: computedNextRunAt, skipped: true as const };
				}
			}

			const task = taskRepo.createTask({
				spaceId: schedule.spaceId,
				title: schedule.title,
				description: schedule.description,
				priority: schedule.priority,
				preferredWorkflowId: schedule.preferredWorkflowId,
				labels: schedule.labels,
				createdByTaskScheduleId: schedule.id,
				goalId: schedule.goalId,
			});

			// Compare-and-swap: only commit if the schedule's pending_job_id is
			// still our job id. If a concurrent pause/delete/reschedule happened
			// between the initial read and now, the precondition fails and we
			// throw — the surrounding transaction rolls back, including the
			// just-created task and the just-enqueued next job.
			const applied = scheduleRepo.updateAfterFireIfPending(scheduleId, job.id, {
				lastCreatedTaskId: task.id,
				lastRunAt: now,
				nextRunAt: computedNextRunAt,
				status: nextStatus,
				pendingJobId,
			});
			if (!applied) {
				throw new ScheduleSupersededError(scheduleId, job.id);
			}
			if (goalService && schedule.goalId) {
				const claimed = goalService.claimScheduledTask(task.id, computedNextRunAt);
				if (!claimed.claimed) {
					throw new Error(`Goal ${schedule.goalId} already has an active task`);
				}
			}

			return { taskId: task.id, nextRunAt: computedNextRunAt, skipped: false as const };
		})();

		taskId = result.taskId;
		nextRunAt = result.nextRunAt;
		if (result.skipped) {
			log.debug('task-schedule-fire: skipped goal contention', { scheduleId, nextRunAt });
		} else {
			log.debug('task-schedule-fire: created task', { scheduleId, taskId, nextRunAt });
		}

		// Emit events so the web client can refresh its state without polling.
		// Fire-and-forget — handler success must not depend on event delivery.
		if (eventHub) {
			if (taskId) {
				const emittedTask = taskRepo.getTask(taskId);
				if (emittedTask) {
					eventHub
						.publish('space.task.created', {
							sessionId: 'global',
							spaceId: schedule.spaceId,
							taskId,
							task: emittedTask,
						})
						.catch(() => {
							// Swallow — event emission is best-effort.
						});
				}
			}
			const emittedSchedule = scheduleRepo.getById(scheduleId);
			if (emittedSchedule) {
				eventHub
					.publish('space.schedule.updated', {
						sessionId: 'global',
						spaceId: schedule.spaceId,
						scheduleId,
						schedule: emittedSchedule,
					})
					.catch(() => {
						// Swallow — event emission is best-effort.
					});
			}
		}
	} catch (err) {
		// A concurrent pause/delete invalidated our pending_job_id mid-flight;
		// the transaction rolled back the task and any next-job enqueue, so
		// nothing was persisted. Surface this as a normal skip — the job queue
		// should not retry it (the schedule is no longer wanting this fire).
		if (err instanceof ScheduleSupersededError) {
			log.debug('task-schedule-fire: skipping — superseded mid-flight', {
				scheduleId,
				jobId: job.id,
			});
			return {
				scheduleId,
				taskId: null,
				skipped: true,
				skipReason: 'job_superseded',
				nextRunAt: null,
			};
		}
		log.error('task-schedule-fire: transaction failed', {
			scheduleId,
			error: err instanceof Error ? err.message : err,
		});
		// Re-throw so the job queue retries with backoff. The transaction
		// rolled back so no half-state was persisted; the next attempt sees
		// the same `pendingJobId === job.id` and proceeds cleanly.
		throw err;
	}

	if (taskId === null) {
		return {
			scheduleId,
			taskId: null,
			skipped: true,
			skipReason: 'goal_task_already_active',
			nextRunAt,
		};
	}

	return { scheduleId, taskId, skipped: false, nextRunAt };
}

function fireGoalAutomationSchedule(params: {
	db: BunDatabase;
	job: Job;
	schedule: TaskSchedule;
	scheduleRepo: TaskScheduleRepository;
	jobQueue: JobQueueRepository;
	goalRepo?: SpaceGoalRepository;
	goalAutomationService?: Pick<GoalAutomationService, 'onSelfNag'>;
	eventHub?: TaskScheduleFireHandlerDeps['eventHub'];
	now: number;
}): TaskScheduleFireResult {
	const {
		db,
		job,
		schedule,
		scheduleRepo,
		jobQueue,
		goalRepo,
		goalAutomationService,
		eventHub,
		now,
	} = params;
	let computedNextRunAt: number | null = null;
	const goal = schedule.goalId ? goalRepo?.getById(schedule.goalId) : null;
	const automationDisabled =
		schedule.status !== 'active' ||
		schedule.goalId === null ||
		(goalRepo !== undefined && (!goal || goal.status !== 'active'));
	try {
		computedNextRunAt = db.transaction(() => {
			let nextRunAt: number | null = null;
			let pendingJobId: string | null = null;
			let nextStatus: 'active' | 'completed' | 'paused' = automationDisabled ? 'paused' : 'active';
			if (nextStatus === 'active' && schedule.triggerType === 'cron' && schedule.cronExpression) {
				nextRunAt = getNextRunAt(schedule.cronExpression, schedule.timezone, now);
				if (nextRunAt !== null) {
					const nextJob = jobQueue.enqueue({
						queue: TASK_SCHEDULE_FIRE,
						payload: { scheduleId: schedule.id } satisfies TaskScheduleFirePayload,
						runAt: nextRunAt,
					});
					pendingJobId = nextJob.id;
				} else {
					nextStatus = 'completed';
				}
			}
			const applied = scheduleRepo.updateAfterFireIfPending(schedule.id, job.id, {
				lastCreatedTaskId: schedule.lastCreatedTaskId,
				lastRunAt: now,
				nextRunAt,
				status: nextStatus,
				pendingJobId,
			});
			if (!applied) throw new ScheduleSupersededError(schedule.id, job.id);
			return nextRunAt;
		})();
	} catch (err) {
		if (err instanceof ScheduleSupersededError) {
			return {
				scheduleId: schedule.id,
				taskId: null,
				skipped: true,
				skipReason: 'job_superseded',
				nextRunAt: null,
			};
		}
		throw err;
	}
	const scopeId = readSelfNagScheduleScopeId(schedule);
	if (!automationDisabled) {
		try {
			goalAutomationService?.onSelfNag(
				schedule.goalId as string,
				schedule.id,
				scopeId ?? undefined
			);
		} catch (err) {
			log.warn('goal automation self-nag enqueue failed after schedule advance', err);
		}
	}
	const emittedSchedule = scheduleRepo.getById(schedule.id);
	if (eventHub && emittedSchedule) {
		eventHub
			.publish('space.schedule.updated', {
				sessionId: 'global',
				spaceId: schedule.spaceId,
				scheduleId: schedule.id,
				schedule: emittedSchedule,
			})
			.catch(() => {
				// Swallow — event emission is best-effort.
			});
	}
	return { scheduleId: schedule.id, taskId: null, skipped: false, nextRunAt: computedNextRunAt };
}
