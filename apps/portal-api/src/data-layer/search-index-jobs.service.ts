// SPDX-License-Identifier: AGPL-3.0-or-later
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, type SearchIndexBuild } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service.js';
import { DataLayerSearchIndexService } from './search-index.service.js';

/**
 * Queue for the housekeeping "Build search indexes" action (2026-11
 * review, 06-5). Index builds on big layers take minutes and hold a
 * write-stalling lock per index, so they do not belong in an HTTP
 * request: the API queues a row here, the worker container claims it
 * and runs DataLayerSearchIndexService.buildForOrg, and the admin page
 * polls the row for the result.
 *
 * At most one build per org is queued or running. A partial unique
 * index enforces it; enqueue() returns the active row when there is
 * one, so a double click does not start a second build.
 */

export type SearchIndexBuildStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

/** What the admin page sees. */
export interface SearchIndexBuildView {
  id: string;
  status: SearchIndexBuildStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: unknown;
  error: string | null;
}

export function toView(row: SearchIndexBuild): SearchIndexBuildView {
  return {
    id: row.id,
    status: row.status as SearchIndexBuildStatus,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    result: row.result ?? null,
    error: row.error,
  };
}

@Injectable()
export class SearchIndexJobsService {
  private readonly log = new Logger(SearchIndexJobsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly indexes: DataLayerSearchIndexService,
  ) {}

  /** Queue a build for the org, or return the one already active. */
  async enqueue(orgId: string, userId: string): Promise<SearchIndexBuildView> {
    const active = await this.active(orgId);
    if (active) return toView(active);
    try {
      const row = await this.prisma.searchIndexBuild.create({
        data: { orgId, requestedBy: userId },
      });
      return toView(row);
    } catch (err) {
      // Two clicks raced past the read above; the unique index let
      // one through. Hand back the winner.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const winner = await this.active(orgId);
        if (winner) return toView(winner);
      }
      throw err;
    }
  }

  /** The org's most recent build, or null when it never ran one. */
  async latest(orgId: string): Promise<SearchIndexBuildView | null> {
    const row = await this.prisma.searchIndexBuild.findFirst({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
    });
    return row ? toView(row) : null;
  }

  private active(orgId: string): Promise<SearchIndexBuild | null> {
    return this.prisma.searchIndexBuild.findFirst({
      where: { orgId, status: { in: ['queued', 'running'] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Claim the oldest queued build. SKIP LOCKED keeps two workers from
   * taking the same row if the worker is ever scaled out.
   */
  async claimNext(): Promise<SearchIndexBuild | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE search_index_build
      SET status = 'running', started_at = now()
      WHERE id = (
        SELECT id FROM search_index_build
        WHERE status = 'queued'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `;
    const id = rows[0]?.id;
    if (!id) return null;
    return this.prisma.searchIndexBuild.findUnique({ where: { id } });
  }

  /** Run one claimed build and record how it ended. */
  async run(job: SearchIndexBuild): Promise<void> {
    try {
      const result = await this.indexes.buildForOrg(job.orgId);
      await this.prisma.searchIndexBuild.update({
        where: { id: job.id },
        data: {
          status: 'succeeded',
          finishedAt: new Date(),
          result: result as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn(`search index build ${job.id} failed: ${message}`);
      await this.prisma.searchIndexBuild.update({
        where: { id: job.id },
        data: {
          status: 'failed',
          finishedAt: new Date(),
          error: message.slice(0, 500),
        },
      });
    }
  }

  /**
   * Called when the worker starts. A build left 'running' belonged to
   * a worker that is gone (one worker runs these), so it will never
   * finish. Mark it failed so the org can queue a new one.
   */
  async failInterrupted(): Promise<number> {
    const r = await this.prisma.searchIndexBuild.updateMany({
      where: { status: 'running' },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        error: 'The worker restarted before this build finished. Run it again.',
      },
    });
    return r.count;
  }
}
